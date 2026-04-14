import { Process, Processor } from '@nestjs/bull';
import { Logger } from '@nestjs/common';
import { Job } from 'bull';

@Processor('example')
export class ExampleProcessor {
  private readonly logger = new Logger(ExampleProcessor.name);

  @Process()
  async handle(job: Job<{ message: string }>) {
    this.logger.log(`Processing job ${job.id}: ${job.data.message}`);
  }
}
