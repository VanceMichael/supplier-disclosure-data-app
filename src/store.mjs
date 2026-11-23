// 存储层：所有录入以追加事件方式保存（append-only JSONL），保证可追认、可对账。
// 事件记录业务来源行（含 known_month）与录入时间；物化视图按 as-of 时点重建。
import { existsSync, mkdirSync, readFileSync, appendFileSync } from 'node:fs';
import { dirname } from 'node:path';

export class EventStore {
  constructor(file) {
    this.file = file;
    this.events = [];
    if (file && existsSync(file)) {
      const lines = readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean);
      for (const line of lines) {
        this.events.push(JSON.parse(line));
      }
    }
  }

  append(table, row, meta = {}) {
    const event = {
      seq: this.events.length + 1,
      table,
      row,
      recorded_at: meta.recordedAt ?? new Date().toISOString(),
      source: meta.source ?? 'entry',
    };
    this.events.push(event);
    if (this.file) {
      mkdirSync(dirname(this.file), { recursive: true });
      appendFileSync(this.file, JSON.stringify(event) + '\n');
    }
    return event;
  }

  rows(table) {
    return this.events.filter(event => event.table === table).map(event => event.row);
  }

  tables() {
    return [...new Set(this.events.map(event => event.table))];
  }
}
