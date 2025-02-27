import {
  QueueSchedulerOptions,
  RedisClient,
  StreamReadRaw,
} from '../interfaces';
import {
  array2obj,
  clientCommandMessageReg,
  DELAY_TIME_5,
  delay,
  isNotConnectionError,
  isRedisInstance,
  QUEUE_SCHEDULER_SUFFIX,
} from '../utils';
import { QueueBase } from './queue-base';
import { Scripts } from './scripts';
import { RedisConnection } from './redis-connection';

export interface QueueSchedulerListener {
  /**
   * Listen to 'error' event.
   *
   * This event is triggered when an exception is thrown.
   */
  error: (error: Error) => void;

  /**
   * Listen to 'failed' event.
   *
   * This event is triggered when a job has thrown an exception.
   */
  failed: (jobId: string, failedReason: Error, prev: string) => void;

  /**
   * Listen to 'stalled' event.
   *
   * This event is triggered when a job gets stalled.
   */
  stalled: (jobId: string, prev: string) => void;
}

/**
 * This class is just used for some automatic bookkeeping of the queue,
 * such as updating the delay set as well as moving stalled jobs back
 * to the waiting list.
 *
 * Jobs are checked for stallness once every "visibility window" seconds.
 * Jobs are then marked as candidates for being stalled, in the next check,
 * the candidates are marked as stalled and moved to wait.
 * Workers need to clean the candidate list with the jobs that they are working
 * on, failing to update the list results in the job ending being stalled.
 *
 * This class requires a dedicated redis connection, and at least one is needed
 * to be running at a given time, otherwise delays, stalled jobs, retries, repeatable
 * jobs, etc, will not work correctly or at all.
 *
 */
export class QueueScheduler extends QueueBase {
  opts: QueueSchedulerOptions;
  private nextTimestamp = Number.MAX_VALUE;
  private isBlocked = false;
  private running = false;

  constructor(
    name: string,
    { connection, autorun = true, ...opts }: QueueSchedulerOptions = {},
    Connection?: typeof RedisConnection,
  ) {
    super(
      name,
      {
        maxStalledCount: 1,
        stalledInterval: 30000,
        ...opts,
        connection: isRedisInstance(connection)
          ? (<RedisClient>connection).duplicate()
          : connection,
        sharedConnection: false,
        blockingConnection: true,
      },
      Connection,
    );

    if (!this.opts.stalledInterval) {
      throw new Error('Stalled interval cannot be zero or undefined');
    }

    if (autorun) {
      this.run().catch(error => {
        this.emit('error', error);
      });
    }
  }

  emit<U extends keyof QueueSchedulerListener>(
    event: U,
    ...args: Parameters<QueueSchedulerListener[U]>
  ): boolean {
    return super.emit(event, ...args);
  }

  off<U extends keyof QueueSchedulerListener>(
    eventName: U,
    listener: QueueSchedulerListener[U],
  ): this {
    super.off(eventName, listener);
    return this;
  }

  on<U extends keyof QueueSchedulerListener>(
    event: U,
    listener: QueueSchedulerListener[U],
  ): this {
    super.on(event, listener);
    return this;
  }

  once<U extends keyof QueueSchedulerListener>(
    event: U,
    listener: QueueSchedulerListener[U],
  ): this {
    super.once(event, listener);
    return this;
  }

  async run(): Promise<void> {
    if (!this.running) {
      try {
        this.running = true;
        const client = await this.waitUntilReady();

        const key = this.keys.delay;
        const opts = this.opts as QueueSchedulerOptions;

        try {
          await client.client(
            'setname',
            this.clientName(QUEUE_SCHEDULER_SUFFIX),
          );
        } catch (err) {
          if (!clientCommandMessageReg.test((<Error>err).message)) {
            throw err;
          }
        }

        const [nextTimestamp, streamId = '0-0'] = await this.updateDelaySet(
          Date.now(),
        );
        let streamLastId = streamId;

        if (nextTimestamp) {
          this.nextTimestamp = nextTimestamp;
        }

        while (!this.closing) {
          // Check if at least the min stalled check time has passed.
          await this.checkConnectionError(() => this.moveStalledJobsToWait());

          // Listen to the delay event stream from lastDelayStreamTimestamp
          // Can we use XGROUPS to reduce redundancy?
          const nextDelay = this.nextTimestamp - Date.now();

          const blockTime = Math.round(
            Math.min(opts.stalledInterval, Math.max(nextDelay, 0)),
          );

          const data = await this.readDelayedData(
            client,
            key,
            streamLastId,
            blockTime,
          );

          if (data && data[0]) {
            const stream = data[0];
            const events = stream[1];

            for (let i = 0; i < events.length; i++) {
              streamLastId = events[i][0];
              const args = array2obj(events[i][1]);
              const nextTimestamp: number = parseInt(args.nextTimestamp);

              if (nextTimestamp < this.nextTimestamp) {
                this.nextTimestamp = nextTimestamp;
              }
            }

            //
            // We trim to a length of 100, which should be a very safe value
            // for all kind of scenarios.
            //
            if (!this.closing) {
              await this.checkConnectionError<number>(() =>
                client.xtrim(key, 'MAXLEN', '~', 100),
              );
            }
          }

          const now = Date.now();
          const nextDelayedJobDelay = this.nextTimestamp - now;

          if (nextDelayedJobDelay <= 0) {
            const [nextTimestamp, id] = await this.updateDelaySet(now);

            if (nextTimestamp) {
              this.nextTimestamp = nextTimestamp;
              streamLastId = id;
            } else {
              this.nextTimestamp = Number.MAX_VALUE;
            }
          }
        }
        this.running = false;
      } catch (error) {
        this.running = false;
        throw error;
      }
    } else {
      throw new Error('Queue Scheduler is already running.');
    }
  }

  isRunning(): boolean {
    return this.running;
  }

  private async readDelayedData(
    client: RedisClient,
    key: string,
    streamLastId: string,
    blockTime: number,
  ): Promise<StreamReadRaw> {
    if (!this.closing) {
      let data;
      if (blockTime) {
        try {
          this.isBlocked = true;
          data = await client.xread(
            'BLOCK',
            blockTime,
            'STREAMS',
            key,
            streamLastId,
          );
        } catch (err) {
          // We can ignore closed connection errors
          if (isNotConnectionError(err as Error)) {
            throw err;
          }

          await delay(DELAY_TIME_5);
        } finally {
          this.isBlocked = false;
        }
      } else {
        data = await this.checkConnectionError(() =>
          client.xread('STREAMS', key, streamLastId),
        );
      }

      // Cast to actual return type, see: https://github.com/DefinitelyTyped/DefinitelyTyped/issues/44301
      return data as any;
    }
  }

  private async updateDelaySet(timestamp: number): Promise<[number, string]> {
    if (!this.closing) {
      const result = await this.checkConnectionError(() =>
        Scripts.updateDelaySet(this, timestamp),
      );

      return result;
    }
    return [0, '0'];
  }

  private async moveStalledJobsToWait() {
    if (!this.closing) {
      const [failed, stalled] = await Scripts.moveStalledJobsToWait(this);

      failed.forEach((jobId: string) =>
        this.emit(
          'failed',
          jobId,
          new Error('job stalled more than allowable limit'),
          'active',
        ),
      );
      stalled.forEach((jobId: string) => this.emit('stalled', jobId, 'active'));
    }
  }

  close(): Promise<void> {
    if (this.closing) {
      return this.closing;
    }
    if (this.isBlocked) {
      this.closing = this.disconnect();
    } else {
      this.closing = super.close();
    }
    return this.closing;
  }
}
