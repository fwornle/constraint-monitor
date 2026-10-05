#!/usr/bin/env node

/**
 * Interactive Constraint Test Result Collector
 *
 * Scans recent LSL transcripts for constraint violations and Claude's responses.
 * Builds an incremental test report showing evidence of hook behavior.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { repoHistoryDir } from '../../lib/history/paths.cjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// FIXED: Correctly resolve coding repo path
// This script is in integrations/constraint-monitor/, so coding repo is ../.. from here
// But path.resolve with relative paths from __dirname doesn't work correctly
// Instead, navigate up from the known location
const CODING_REPO = path.resolve(__dirname, '../../');
const LSL_DIR = repoHistoryDir(CODING_REPO);
const REPORT_FILE = path.join(__dirname, 'INTERACTIVE-TEST-REPORT.md');

// Verify we found the right directory
if (!fs.existsSync(LSL_DIR)) {
  console.error(`❌ Error: LSL directory not found at: ${LSL_DIR}`);
  console.error(`   Calculated CODING_REPO as: ${CODING_REPO}`);
  console.error(`   Script location (__dirname): ${__dirname}`);
  process.exit(1);
}

// Test definitions matching INTERACTIVE-TEST-PROMPTS.md
const TEST_DEFINITIONS = [
  { id: 1, constraint: 'no-hardcoded-secrets', severity: 'CRITICAL', keywords: ['API_KEY', 'sk-', 'PASSWORD', 'hardcoded', 'secret'] },
  { id: 2, constraint: 'no-eval-usage', severity: 'CRITICAL', keywords: ['eval(', 'eval', 'dynamic code'] },
  { id: 3, constraint: 'no-parallel-files', severity: 'CRITICAL', keywords: ['-v2', 'version suffix', 'parallel'] },
  { id: 4, constraint: 'proper-error-handling', severity: 'ERROR', keywords: ['empty catch', 'catch()', 'error handling'] },
  { id: 5, constraint: 'debug-not-speculate', severity: 'ERROR', keywords: ['might be', 'probably', 'speculate'] },
  { id: 6, constraint: 'no-evolutionary-names', severity: 'ERROR', keywords: ['-improved', 'enhanced', 'evolutionary'] },
  { id: 7, constraint: 'plantuml-standard-styling', severity: 'ERROR', keywords: ['skinparam', 'custom color', 'styling'] },
  { id: 8, constraint: 'no-console-log', severity: 'WARNING', keywords: ['console.log', 'console'] },
  { id: 9, constraint: 'no-var-declarations', severity: 'WARNING', keywords: ['var ', 'var declaration'] },
  { id: 10, constraint: 'plantuml-file-location', severity: 'WARNING', keywords: ['PlantUML', '.puml', 'diagram location'] },
  { id: 11, constraint: 'image-reference-pattern', severity: 'WARNING', keywords: ['image', 'screenshot', 'reference'] },
  { id: 12, constraint: 'proper-function-naming', severity: 'INFO', keywords: ['CalculateTotal', 'PascalCase', 'naming'] },
  { id: 14, constraint: 'plantuml-diagram-workflow', severity: 'INFO', keywords: ['PlantUML', 'workflow', 'diagram'] },
  { id: 15, constraint: 'plantuml-readability-guidelines', severity: 'INFO', keywords: ['readability', 'PlantUML', 'nested'] },
  { id: 16, constraint: 'plantuml-file-organization', severity: 'INFO', keywords: ['organization', 'PlantUML', 'multiple'] },
  { id: 17, constraint: 'documentation-filename-format', severity: 'INFO', keywords: ['UserGuide', 'filename', 'documentation'] },
  { id: 18, constraint: 'update-main-readme', severity: 'INFO', keywords: ['README', 'update', 'main'] }
];

class TestResultCollector {
  constructor() {
    this.existingResults = this.loadExistingReport();
    this.newFindings = [];
  }

  loadExistingReport() {
    if (!fs.existsSync(REPORT_FILE)) {
      return {};
    }

    const content = fs.readFileSync(REPORT_FILE, 'utf-8');
    const results = {};

    // Parse existing test results from report
    const testMatches = content.matchAll(/### Test (\d+): (.+?)\n[\s\S]*?\*\*Status:\*\* (.+?)\n/g);
    for (const match of testMatches) {
      const [, id, , status] = match;
      results[id] = status.includes('✅');
    }

    return results;
  }

  async findRecentLSL(minutes = 60) {
    if (!fs.existsSync(LSL_DIR)) {
      console.log(`❌ LSL directory not found: ${LSL_DIR}`);
      return null;
    }

    // FIXED: Calculate current time-based LSL filename directly
    // LSL files use hourly windows: YYYY-MM-DD_HHMM-HHMM_<userhash>.md
    // Note: LSL files use LOCAL time, not UTC
    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const day = String(now.getDate()).padStart(2, '0');
    const hour = String(now.getHours()).padStart(2, '0');

    // Calculate hour window: current hour to next hour
    const startHour = hour + '00';
    const endHourNum = (parseInt(hour) + 1) % 24;
    const endHour = String(endHourNum).padStart(2, '0') + '00';

    const datePrefix = `${year}-${month}-${day}_${startHour}-${endHour}`;

    console.log(`🕐 Current local time: ${now.toLocaleTimeString()}`);
    console.log(`📅 Looking for LSL files matching: ${datePrefix}_*.md`);

    // Find file matching current time window
    const files = fs.readdirSync(LSL_DIR)
      .filter(f => f.endsWith('.md') && f.startsWith(datePrefix))
      .map(f => ({
        name: f,
        path: path.join(LSL_DIR, f),
        mtime: fs.statSync(path.join(LSL_DIR, f)).mtime
      }))
      .sort((a, b) => b.mtime.getTime() - a.mtime.getTime());

    if (files.length > 0) {
      console.log(`📋 Found current LSL file: ${files[0].name}`);
      return files[0].path;
    }

    // Fallback: find most recent file from today
    console.log(`\n🔄 Current time window file not found, checking all files from today...`);
    const todayPrefix = `${year}-${month}-${day}`;
    const allFiles = fs.readdirSync(LSL_DIR);
    console.log(`   Total files in directory: ${allFiles.length}`);

    const todayFiles = allFiles
      .filter(f => f.endsWith('.md') && f.startsWith(todayPrefix))
      .map(f => ({
        name: f,
        path: path.join(LSL_DIR, f),
        mtime: fs.statSync(path.join(LSL_DIR, f)).mtime
      }))
      .sort((a, b) => b.mtime.getTime() - a.mtime.getTime());

    console.log(`   Files matching today (${todayPrefix}): ${todayFiles.length}`);
    if (todayFiles.length > 0) {
      console.log(`   Most recent: ${todayFiles[0].name}`);
      console.log(`\n📋 Using most recent LSL file from today`);
      return todayFiles[0].path;
    }

    console.log(`\n⚠️  No LSL files found for today`);
    return null;
  }

  analyzeLSL(lslPath) {
    console.log(`🔍 Analyzing: ${path.basename(lslPath)}`);

    const content = fs.readFileSync(lslPath, 'utf-8');
    const findings = [];

    // Look for constraint violation patterns
    const violationPattern = /(?:🚫|⚠️|ℹ️).*?(CONSTRAINT|constraint|violation)/gi;
    const matches = content.match(violationPattern);

    if (!matches || matches.length === 0) {
      console.log('   No constraint violations found in transcript');
      return findings;
    }

    console.log(`   Found ${matches.length} potential constraint reference(s)`);

    // Analyze each test definition
    for (const test of TEST_DEFINITIONS) {
      // Skip if already tested
      if (this.existingResults[test.id]) {
        continue;
      }

      // Check if keywords appear in transcript
      const hasKeywords = test.keywords.some(kw =>
        content.toLowerCase().includes(kw.toLowerCase())
      );

      if (!hasKeywords) {
        continue;
      }

      console.log(`   ✅ Potential match for Test ${test.id}: ${test.constraint}`);

      // Extract relevant section
      const finding = this.extractEvidence(content, test);
      if (finding) {
        findings.push({ ...test, ...finding });
      }
    }

    return findings;
  }

  extractEvidence(content, test) {
    // Find user prompt section
    const promptMatch = content.match(/(?:### User|## User Prompt|User:)\s*\n([\s\S]{0,500})/);
    const userPrompt = promptMatch ? promptMatch[1].trim().substring(0, 300) : 'Not captured';

    // Find constraint violation message
    const violationMatch = content.match(/(?:🚫|⚠️|ℹ️)[^\n]*(?:CONSTRAINT|constraint|violation)[^\n]*\n([\s\S]{0,800}?)(?:\n#{2,}|\n\n\n)/i);
    const hookMessage = violationMatch ? violationMatch[0].trim() : '';

    // Find Claude's response after hook
    const claudeMatch = content.match(/(?:### Assistant|## Claude Response|Claude:)\s*\n([\s\S]{0,600})/);
    const claudeResponse = claudeMatch ? claudeMatch[1].trim().substring(0, 400) : 'Not captured';

    // Determine if blocked
    const wasBlocked = hookMessage.toLowerCase().includes('blocked') ||
                       hookMessage.toLowerCase().includes('execution blocked');

    const wasWarned = hookMessage.includes('⚠️') || hookMessage.toLowerCase().includes('warning');
    const wasInfo = hookMessage.includes('ℹ️') || hookMessage.toLowerCase().includes('info');

    // Verify behavior matches severity
    let status = '❓ INCONCLUSIVE';
    let passed = false;

    if (test.severity === 'CRITICAL' || test.severity === 'ERROR') {
      if (wasBlocked) {
        status = '✅ PASSED';
        passed = true;
      } else {
        status = '❌ FAILED (should have blocked)';
      }
    } else if (test.severity === 'WARNING') {
      if (wasWarned && !wasBlocked) {
        status = '✅ PASSED';
        passed = true;
      } else if (wasBlocked) {
        status = '❌ FAILED (should warn, not block)';
      } else {
        status = '❌ FAILED (no warning shown)';
      }
    } else if (test.severity === 'INFO') {
      if (wasInfo && !wasBlocked) {
        status = '✅ PASSED';
        passed = true;
      } else if (wasBlocked) {
        status = '❌ FAILED (should inform, not block)';
      }
    }

    return {
      userPrompt,
      hookMessage: hookMessage || 'No hook message captured',
      claudeResponse,
      wasBlocked,
      status,
      passed,
      timestamp: new Date().toISOString()
    };
  }

  generateReport(findings) {
    let report = fs.existsSync(REPORT_FILE)
      ? fs.readFileSync(REPORT_FILE, 'utf-8')
      : this.generateReportHeader();

    // Add new findings
    for (const finding of findings) {
      const testSection = this.formatTestResult(finding);

      // Check if test already exists
      const testMarker = `### Test ${finding.id}:`;
      if (report.includes(testMarker)) {
        // Update existing test
        const regex = new RegExp(`${testMarker}[\\s\\S]*?(?=###|$)`, 'g');
        report = report.replace(regex, testSection + '\n\n');
      } else {
        // Add new test (insert before summary if exists, otherwise append)
        if (report.includes('## Test Summary')) {
          report = report.replace('## Test Summary', testSection + '\n\n## Test Summary');
        } else {
          report += '\n\n' + testSection;
        }
      }

      this.existingResults[finding.id] = finding.passed;
    }

    // Update summary
    report = this.updateSummary(report);

    fs.writeFileSync(REPORT_FILE, report);
    console.log(`\n📄 Report updated: ${REPORT_FILE}`);
    console.log(`   New findings: ${findings.length}`);
    console.log(`   Total tested: ${Object.keys(this.existingResults).length}/18`);
  }

  generateReportHeader() {
    return `# Interactive Constraint Monitoring Test Report

**Test Type:** Interactive Claude Code Sessions with Real Hook Interception
**Evidence Source:** Live Session Logs (LSL)
**Test Date Started:** ${new Date().toISOString().split('T')[0]}

## Overview

This report documents real constraint monitoring behavior observed in interactive Claude Code sessions.
Each test shows actual hook interception, blocking behavior, and Claude's adaptive responses.

**Status Legend:**
- 🔴 **CRITICAL** - Must block execution
- 🟠 **ERROR** - Must block execution
- 🟡 **WARNING** - Must warn but allow
- 🔵 **INFO** - Must inform but allow

---

## Test Results

`;
  }

  formatTestResult(finding) {
    const emoji = {
      'CRITICAL': '🔴',
      'ERROR': '🟠',
      'WARNING': '🟡',
      'INFO': '🔵'
    }[finding.severity];

    return `### Test ${finding.id}: ${finding.constraint}

**Severity:** ${emoji} ${finding.severity}
**Status:** ${finding.status}
**Tested:** ${finding.timestamp.split('T')[0]}

**User Prompt:**
\`\`\`
${finding.userPrompt}
\`\`\`

**Hook Message:**
\`\`\`
${finding.hookMessage}
\`\`\`

**Was Blocked:** ${finding.wasBlocked ? '✅ YES' : '❌ NO'}

**Claude's Response:**
> ${finding.claudeResponse.split('\n').map(l => l.trim()).join('\n> ')}

---`;
  }

  updateSummary(report) {
    const total = TEST_DEFINITIONS.length;
    const tested = Object.keys(this.existingResults).length;
    const passed = Object.values(this.existingResults).filter(v => v).length;
    const failed = tested - passed;

    const summarySection = `

## Test Summary

**Progress:** ${tested}/${total} tests completed (${Math.round(tested/total*100)}%)

**Results:**
- ✅ **Passed:** ${passed}/${tested}
- ❌ **Failed:** ${failed}/${tested}
- ⏳ **Remaining:** ${total - tested}

**By Severity:**
- 🔴 CRITICAL: ${this.countBySeverity('CRITICAL')}
- 🟠 ERROR: ${this.countBySeverity('ERROR')}
- 🟡 WARNING: ${this.countBySeverity('WARNING')}
- 🔵 INFO: ${this.countBySeverity('INFO')}

---

*Report last updated: ${new Date().toISOString()}*
*Run \`node collect-test-results.js\` after each test to update this report*
`;

    // Remove old summary if exists
    const summaryMarker = '## Test Summary';
    if (report.includes(summaryMarker)) {
      report = report.substring(0, report.indexOf(summaryMarker));
    }

    return report + summarySection;
  }

  countBySeverity(severity) {
    const tests = TEST_DEFINITIONS.filter(t => t.severity === severity);
    const tested = tests.filter(t => this.existingResults[t.id] !== undefined).length;
    const passed = tests.filter(t => this.existingResults[t.id] === true).length;
    return `${passed}/${tested} tested (${tests.length} total)`;
  }

  async collect() {
    console.log('🔍 CONSTRAINT TEST RESULT COLLECTOR');
    console.log('====================================\n');

    const lslPath = await this.findRecentLSL(60);
    if (!lslPath) {
      console.log('\n💡 Tip: Run test prompts in an interactive Claude session first');
      console.log('   Then run this collector to extract results from LSL transcripts');
      return;
    }

    const findings = this.analyzeLSL(lslPath);

    if (findings.length === 0) {
      console.log('\n⚠️  No new constraint test evidence found in recent transcript');
      console.log('   Make sure to issue test prompts from INTERACTIVE-TEST-PROMPTS.md');
    } else {
      this.generateReport(findings);
      console.log(`\n✅ Collected evidence for ${findings.length} constraint test(s)`);
      console.log(`   View report: ${REPORT_FILE}`);
    }
  }
}

// Run collector
const collector = new TestResultCollector();
collector.collect().catch(console.error);
