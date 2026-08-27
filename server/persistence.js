'use strict';

const fs = require('fs');
const path = require('path');

/**
 * Small persistence adapter used by the MVP. It deliberately exposes a narrow
 * game-history interface so it can be swapped for PostgreSQL/Redis later
 * without changing room or gameplay code.
 */
class JsonGameStore {
  constructor(filePath) {
    this.filePath = filePath || path.join(process.cwd(), 'data', 'games.json');
    this.records = [];
    this.ensureLoaded();
  }

  ensureLoaded() {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    try {
      const raw = fs.readFileSync(this.filePath, 'utf8');
      const parsed = JSON.parse(raw);
      this.records = Array.isArray(parsed) ? parsed : [];
    } catch (error) {
      if (error.code !== 'ENOENT') {
        // A malformed history file should not prevent the live game server
        // from booting. Keep the file intact for later diagnostics.
        this.records = [];
      }
    }
  }

  write() {
    const temporaryPath = `${this.filePath}.tmp`;
    fs.writeFileSync(temporaryPath, JSON.stringify(this.records, null, 2), 'utf8');
    fs.renameSync(temporaryPath, this.filePath);
  }

  upsert(gameRecord) {
    const index = this.records.findIndex((record) => record.gameId === gameRecord.gameId);
    if (index === -1) this.records.push(gameRecord);
    else this.records[index] = gameRecord;
    this.write();
    return gameRecord;
  }

  findForUser(userId) {
    return this.records
      .filter((record) => record.whitePlayerId === userId || record.blackPlayerId === userId)
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
      .map((record) => Object.assign({}, record));
  }

  findByIdForUser(gameId, userId) {
    const record = this.records.find((item) => item.gameId === gameId);
    if (!record || (record.whitePlayerId !== userId && record.blackPlayerId !== userId)) return null;
    return Object.assign({}, record);
  }
}

module.exports = { JsonGameStore };
