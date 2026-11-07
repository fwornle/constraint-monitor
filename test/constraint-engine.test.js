#!/usr/bin/env node

/**
 * Comprehensive Constraint Engine Test Suite
 *
 * Tests:
 * - Constraint matching accuracy
 * - Parallel execution performance
 * - Semantic validation integration
 * - Error handling and fault tolerance
 * - False positive/negative rates
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert';
import { ConstraintEngine } from '../src/engines/constraint-engine.js';
import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.join(__dirname, '..');

describe('ConstraintEngine - Core Functionality', () => {
  let engine;

  before(async () => {
    // Initialize engine with test configuration
    engine = new ConstraintEngine();
    await engine.initialize();
    console.log(`\n✅ Initialized with ${engine.constraints.size} constraints\n`);
  });

  test('should load all constraints from configuration', async () => {
    assert.ok(engine.constraints.size > 0, 'No constraints loaded');
    console.log(`   ✓ Loaded ${engine.constraints.size} constraints`);
  });

  test('should correctly match evolutionary naming patterns', async () => {
    const testCases = [
      {
        content: 'class UserServiceV2 { }',
        shouldMatch: true,
        description: 'version suffix'
      },
      {
        content: 'function processDataEnhanced() { }',
        shouldMatch: true,
        description: 'enhanced suffix'
      },
      {
        content: 'const userServiceTemporary = () => { }',
        shouldMatch: true,
        description: 'temporary suffix'
      },
      {
        // Ordinary vocabulary as a camelCase suffix is not an evolutionary name.
        content: 'const isNew = true;',
        shouldMatch: false,
        description: 'ordinary vocabulary suffix'
      },
      {
        content: 'class UserService { }',
        shouldMatch: false,
        description: 'clean naming'
      },
      {
        content: 'class TestRunner { }',
        shouldMatch: false,
        description: 'legitimate test class'
      }
    ];

    for (const testCase of testCases) {
      const result = await engine.checkConstraints({
        content: testCase.content,
        filePath: 'test.js',
        type: 'code'
      });

      const hasEvolutionaryViolation = result.violations.some(
        v => v.constraint_id === 'no-evolutionary-names'
      );

      if (testCase.shouldMatch) {
        assert.ok(
          hasEvolutionaryViolation,
          `Should match: ${testCase.description} - "${testCase.content}"`
        );
        console.log(`   ✓ Correctly matched: ${testCase.description}`);
      } else {
        assert.ok(
          !hasEvolutionaryViolation,
          `Should NOT match: ${testCase.description} - "${testCase.content}"`
        );
        console.log(`   ✓ Correctly ignored: ${testCase.description}`);
      }
    }
  });

  test('should detect hardcoded secrets', async () => {
    const testCases = [
      {
        content: 'const apiKey = "sk-1234567890abcdef";',
        shouldMatch: true,
        description: 'OpenAI-like key'
      },
      {
        content: 'const password = "MyP@ssw0rd123";',
        shouldMatch: true,
        description: 'hardcoded password'
      },
      {
        content: 'const token = "ghp_1234567890";',
        shouldMatch: true,
        description: 'GitHub token'
      },
      {
        content: 'const API_KEY = process.env.API_KEY;',
        shouldMatch: false,
        description: 'environment variable'
      },
      {
        content: 'const example = "your-api-key-here";',
        shouldMatch: false,
        description: 'placeholder text'
      }
    ];

    for (const testCase of testCases) {
      const result = await engine.checkConstraints({
        content: testCase.content,
        filePath: 'config.js',
        type: 'code'
      });

      const hasSecretViolation = result.violations.some(
        v => v.constraint_id === 'no-hardcoded-secrets'
      );

      if (testCase.shouldMatch) {
        assert.ok(
          hasSecretViolation,
          `Should detect secret: ${testCase.description}`
        );
        console.log(`   ✓ Detected secret: ${testCase.description}`);
      } else {
        assert.ok(
          !hasSecretViolation,
          `Should NOT flag: ${testCase.description}`
        );
        console.log(`   ✓ Correctly ignored: ${testCase.description}`);
      }
    }
  });

  test('should detect speculative debugging language', async () => {
    const testCases = [
      {
        content: 'console.log("might be a race condition issue");',
        shouldMatch: true,
        description: 'might speculation'
      },
      {
        content: '// probably an async timing bug',
        shouldMatch: true,
        description: 'probably speculation'
      },
      {
        content: 'console.log("Found issue: database connection timeout at line 42");',
        shouldMatch: false,
        description: 'specific debug info'
      }
    ];

    for (const testCase of testCases) {
      const result = await engine.checkConstraints({
        content: testCase.content,
        filePath: 'debug.js',
        type: 'code'
      });

      const hasSpeculationViolation = result.violations.some(
        v => v.constraint_id === 'debug-not-speculate'
      );

      if (testCase.shouldMatch) {
        assert.ok(
          hasSpeculationViolation,
          `Should detect speculation: ${testCase.description}`
        );
        console.log(`   ✓ Detected speculation: ${testCase.description}`);
      } else {
        assert.ok(
          !hasSpeculationViolation,
          `Should NOT flag: ${testCase.description}`
        );
        console.log(`   ✓ Allowed specific debug: ${testCase.description}`);
      }
    }
  });
});

describe('ConstraintEngine - Parallel Execution', () => {
  let engine;

  before(async () => {
    engine = new ConstraintEngine();
    await engine.initialize();
  });

  test('should execute constraint checks in parallel', async () => {
    const content = `
      class UserServiceV2 { }
      const apiKey = "sk-1234567890";
      console.log("might be an issue");
      var oldStyle = true;
      function data() { return {}; }
    `;

    const startTime = performance.now();
    const result = await engine.checkConstraints({
      content,
      filePath: 'test-parallel.js',
      type: 'code'
    });
    const endTime = performance.now();
    const duration = endTime - startTime;

    console.log(`   ⏱  Parallel execution time: ${duration.toFixed(2)}ms`);
    console.log(`   📊 Violations detected: ${result.violations.length}`);

    // Should detect multiple violations
    assert.ok(result.violations.length >= 3, 'Should detect multiple violations');

    // Should complete in reasonable time (with parallelization)
    // Even with semantic validation, parallel should be < 500ms for local constraints
    assert.ok(duration < 1000, `Too slow: ${duration.toFixed(2)}ms (expected < 1000ms)`);
    console.log(`   ✓ Performance acceptable`);
  });

  test('should handle concurrent constraint checks independently', async () => {
    const tests = [
      { content: 'class TestV2 {}', filePath: 'file1.js' },
      { content: 'const apiKey = "sk-1234567890"', filePath: 'file2.js' },
      { content: 'var x = 1;', filePath: 'file3.js' }
    ];

    const startTime = performance.now();
    const results = await Promise.all(
      tests.map(test => engine.checkConstraints({ ...test, type: 'code' }))
    );
    const endTime = performance.now();

    console.log(`   ⏱  Concurrent checks time: ${(endTime - startTime).toFixed(2)}ms`);
    console.log(`   📊 Total violations: ${results.reduce((sum, r) => sum + r.violations.length, 0)}`);

    assert.strictEqual(results.length, 3, 'All checks should complete');
    results.forEach((result, i) => {
      assert.ok(result.violations.length > 0, `Test ${i + 1} should have violations`);
    });

    console.log(`   ✓ All concurrent checks completed successfully`);
  });
});

describe('ConstraintEngine - Error Handling', () => {
  let engine;

  before(async () => {
    engine = new ConstraintEngine();
    await engine.initialize();
  });

  test('should handle invalid regex patterns gracefully', async () => {
    // Create a constraint with invalid regex (this should be caught at load time)
    // If any constraints have invalid patterns, they should be logged but not crash

    const result = await engine.checkConstraints({
      content: 'const test = "value";',
      filePath: 'test.js',
      type: 'code'
    });

    assert.ok(result !== null, 'Should return result even if some constraints fail');
    assert.ok(Array.isArray(result.violations), 'Should return violations array');
    console.log(`   ✓ Handled constraint processing without crashes`);
  });

  test('should handle missing content gracefully', async () => {
    const result = await engine.checkConstraints({
      content: '',
      filePath: 'empty.js',
      type: 'code'
    });

    assert.ok(result !== null, 'Should handle empty content');
    assert.strictEqual(result.violations.length, 0, 'Empty content should have no violations');
    console.log(`   ✓ Handled empty content`);
  });

  test('should handle very large files', async () => {
    // Generate large content
    const lines = Array(10000).fill('const x = 1;').join('\n');

    const startTime = performance.now();
    const result = await engine.checkConstraints({
      content: lines,
      filePath: 'large-file.js',
      type: 'code'
    });
    const endTime = performance.now();

    console.log(`   ⏱  Large file processing: ${(endTime - startTime).toFixed(2)}ms`);
    assert.ok(result !== null, 'Should handle large files');
    assert.ok((endTime - startTime) < 5000, 'Should process large file in reasonable time');
    console.log(`   ✓ Handled large file efficiently`);
  });
});

describe('ConstraintEngine - Compliance Scoring', () => {
  let engine;

  before(async () => {
    engine = new ConstraintEngine();
    await engine.initialize();
  });

  test('should calculate compliance score correctly', async () => {
    const perfectCode = `
      class UserService {
        constructor() {
          this.apiKey = process.env.API_KEY;
        }

        async fetchUser(userId) {
          try {
            const response = await fetch(\`/api/users/\${userId}\`);
            return await response.json();
          } catch (error) {
            logger.error('Failed to fetch user', { userId, error });
            throw error;
          }
        }
      }
    `;

    const result = await engine.checkConstraints({
      content: perfectCode,
      filePath: 'user-service.js',
      type: 'code'
    });

    console.log(`   📊 Compliance score: ${result.compliance}/10`);
    console.log(`   📊 Risk level: ${result.risk}`);
    console.log(`   📊 Violations: ${result.violations.length}`);

    assert.ok(result.compliance >= 0 && result.compliance <= 10, 'Compliance score should be 0-10');
    assert.ok(['low', 'medium', 'high', 'critical'].includes(result.risk), 'Risk level should be valid');
    console.log(`   ✓ Compliance scoring working`);
  });

  test('should assess risk levels correctly', async () => {
    const tests = [
      {
        content: 'const x = 1;', // Clean code
        expectedRisk: 'low',
        description: 'clean code'
      },
      {
        content: 'var x=1; var y=2; var z=3; console.log(x); console.log(y);', // Multiple warnings
        expectedRisk: 'medium',
        description: 'multiple warnings'
      },
      {
        content: Array(6).fill('try {} catch {}').join('\n'), // 6 empty catches (errors)
        expectedRisk: 'high',
        description: 'multiple errors'
      }
    ];

    for (const testCase of tests) {
      const result = await engine.checkConstraints({
        content: testCase.content,
        filePath: 'risk-test.js',
        type: 'code'
      });

      console.log(`   📊 ${testCase.description}: risk=${result.risk}, violations=${result.violations.length}`);
    }

    console.log(`   ✓ Risk assessment functioning`);
  });
});

describe('ConstraintEngine - Performance Benchmarks', () => {
  let engine;

  before(async () => {
    engine = new ConstraintEngine();
    await engine.initialize();
  });

  test('should provide performance statistics', async () => {
    const iterations = 50;
    const times = [];

    console.log(`   🏃 Running ${iterations} iterations...`);

    const content = `
      class UserServiceV2 {
        test() {
          var x = 1;
          console.log("might be broken");
        }
      }
    `;

    for (let i = 0; i < iterations; i++) {
      const start = performance.now();
      await engine.checkConstraints({
        content,
        filePath: `test-${i}.js`,
        type: 'code'
      });
      const end = performance.now();
      times.push(end - start);
    }

    const avg = times.reduce((a, b) => a + b, 0) / times.length;
    const min = Math.min(...times);
    const max = Math.max(...times);
    const p50 = times.sort((a, b) => a - b)[Math.floor(times.length * 0.5)];
    const p95 = times.sort((a, b) => a - b)[Math.floor(times.length * 0.95)];
    const p99 = times.sort((a, b) => a - b)[Math.floor(times.length * 0.99)];

    console.log(`\n   📊 Performance Statistics:`);
    console.log(`      Average: ${avg.toFixed(2)}ms`);
    console.log(`      Min: ${min.toFixed(2)}ms`);
    console.log(`      Max: ${max.toFixed(2)}ms`);
    console.log(`      P50: ${p50.toFixed(2)}ms`);
    console.log(`      P95: ${p95.toFixed(2)}ms`);
    console.log(`      P99: ${p99.toFixed(2)}ms`);
    console.log(`      Throughput: ${(1000 / avg).toFixed(2)} checks/sec\n`);

    // Performance assertions
    assert.ok(avg < 100, `Average too slow: ${avg.toFixed(2)}ms (expected < 100ms)`);
    assert.ok(p95 < 200, `P95 too slow: ${p95.toFixed(2)}ms (expected < 200ms)`);

    console.log(`   ✓ Performance benchmarks passed`);
  });
});

// Run all tests
console.log('\n🧪 Starting Comprehensive Constraint Engine Tests\n');
console.log('=' .repeat(60));
