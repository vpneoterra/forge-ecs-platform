/**
 * Basic smoke tests for FORGE ECS Platform CDK stacks.
 * Run: npm test
 */

import { SOLVER_MANIFEST, ALWAYS_ON_TASKS, SQS_DRIVEN_TASKS, getTask } from '../lib/config/solver-manifest';
import { PROVIDER_A, PROVIDER_B, PROVIDER_C, ALL_PROVIDERS } from '../lib/config/capacity-providers';

describe('SOLVER_MANIFEST', () => {
  test('has exactly 8 tasks', () => {
    expect(SOLVER_MANIFEST).toHaveLength(8);
  });

  test('all tasks have required fields', () => {
    for (const task of SOLVER_MANIFEST) {
      expect(task.name).toBeTruthy();
      expect(task.imageRepo).toBeTruthy();
      expect(task.cpu).toBeGreaterThan(0);
      expect(task.memory).toBeGreaterThan(0);
      expect(task.port).toBeGreaterThan(0);
      expect(['A', 'B', 'C']).toContain(task.provider);
      expect(['always-on', 'sqs-driven', 'schedule']).toContain(task.scalingMode);
    }
  });

  test('SQS-driven tasks have sqsQueueName', () => {
    for (const task of SQS_DRIVEN_TASKS) {
      expect(task.sqsQueueName).toBeTruthy();
      expect(task.sqsQueueName).toMatch(/\.fifo$/);
    }
  });

  test('always-on tasks are on Provider A', () => {
    for (const task of ALWAYS_ON_TASKS) {
      expect(task.provider).toBe('A');
    }
  });

  test('always-on tasks fit on 2x c6g.xlarge (max 2 Provider A instances)', () => {
    const totalCpu = ALWAYS_ON_TASKS.reduce((sum, t) => sum + t.cpu, 0);
    const totalMemory = ALWAYS_ON_TASKS.reduce((sum, t) => sum + t.memory, 0);
    // Provider A max = 2 instances, each c6g.xlarge: 4096 CPU units, 8192 MB
    // Leave ~10% headroom for ECS agent
    const maxCpu = 2 * 4096 * 0.9;
    const maxMemory = 2 * 8192 * 0.9;
    expect(totalCpu).toBeLessThanOrEqual(maxCpu);
    expect(totalMemory).toBeLessThanOrEqual(maxMemory);
  });

  test('getTask finds tasks by name', () => {
    const task = getTask('forge-lightweight');
    expect(task.name).toBe('forge-lightweight');
  });

  test('getTask throws for unknown task', () => {
    expect(() => getTask('does-not-exist')).toThrow();
  });

  test('no duplicate task names', () => {
    const names = SOLVER_MANIFEST.map(t => t.name);
    const unique = new Set(names);
    expect(unique.size).toBe(names.length);
  });

  test('no duplicate SQS queue names', () => {
    const queueNames = SOLVER_MANIFEST
      .filter(t => t.sqsQueueName)
      .map(t => t.sqsQueueName!);
    const unique = new Set(queueNames);
    expect(unique.size).toBe(queueNames.length);
  });
});

describe('Capacity Providers', () => {
  test('Provider A is always-on (min >= 1)', () => {
    expect(PROVIDER_A.minCapacity).toBeGreaterThanOrEqual(1);
  });

  test('Provider B scales to zero (min = 0)', () => {
    expect(PROVIDER_B.minCapacity).toBe(0);
  });

  test('Provider C scales to zero (min = 0)', () => {
    expect(PROVIDER_C.minCapacity).toBe(0);
  });

  test('Provider A uses ARM64', () => {
    expect(PROVIDER_A.architecture).toBe('arm64');
  });

  test('Provider B uses x86_64', () => {
    expect(PROVIDER_B.architecture).toBe('x86_64');
  });

  test('all providers use Spot', () => {
    for (const provider of ALL_PROVIDERS) {
      expect(provider.spot).toBe(true);
    }
  });

  test('Provider A monthly cost is under $60', () => {
    expect(PROVIDER_A.estimatedMonthlyMin).toBeLessThan(60);
  });

  test('ALL_PROVIDERS has 3 providers', () => {
    expect(ALL_PROVIDERS).toHaveLength(3);
  });
});
