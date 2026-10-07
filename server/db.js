'use strict';
const { DatabaseSync } = require('node:sqlite');
const fs = require('fs'), path = require('path'), config = require('./config');
fs.mkdirSync(path.dirname(config.dbPath), { recursive: true });
const db = new DatabaseSync(config.dbPath);
db.exec(`
PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
CREATE TABLE IF NOT EXISTS users(
  id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT UNIQUE, pw_salt TEXT, pw_hash TEXT,
  is_guest INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS sessions(
  token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS ideas(
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  archived INTEGER NOT NULL DEFAULT 0, favorite INTEGER NOT NULL DEFAULT 0, data TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS ideas_user ON ideas(user_id, updated_at);
CREATE TABLE IF NOT EXISTS mind_maps(
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  idea_id TEXT NOT NULL UNIQUE REFERENCES ideas(id) ON DELETE CASCADE,
  title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', manual INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS mind_map_nodes(
  map_id TEXT NOT NULL REFERENCES mind_maps(id) ON DELETE CASCADE, id TEXT NOT NULL, parent_id TEXT,
  title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', notes TEXT NOT NULL DEFAULT '',
  type TEXT NOT NULL, position_x REAL NOT NULL, position_y REAL NOT NULL, color TEXT NOT NULL, icon TEXT NOT NULL DEFAULT '',
  is_collapsed INTEGER NOT NULL DEFAULT 0, is_completed INTEGER NOT NULL DEFAULT 0, ord REAL NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY(map_id, id));
CREATE TABLE IF NOT EXISTS connections(
  map_id TEXT NOT NULL REFERENCES mind_maps(id) ON DELETE CASCADE, id TEXT NOT NULL,
  source_node_id TEXT NOT NULL, target_node_id TEXT NOT NULL, label TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL,
  PRIMARY KEY(map_id, id));
CREATE TABLE IF NOT EXISTS ai_usage(
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, day TEXT NOT NULL, count INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(user_id, day));
CREATE TABLE IF NOT EXISTS user_kv(
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, k TEXT NOT NULL, v TEXT NOT NULL, PRIMARY KEY(user_id, k));
`);
db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(Date.now());
const tx = fn => { db.exec('BEGIN IMMEDIATE'); try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; } };
module.exports = { db, tx };
