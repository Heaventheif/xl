"use strict";

// fca-nx only needs a small runtime cache for user/thread metadata.
// This replaces the old Sequelize/SQLite layer which was not authoritative
// session storage and caused native-install problems on Termux/Android.

const MAX_USERS = 5000;
const MAX_THREADS = 5000;

function makeModel({ idField, maxSize, defaults = {} }) {
  const rows = new Map();

  const touch = (record) => {
    record.updatedAt = new Date();
    if (!record.createdAt) record.createdAt = record.updatedAt;
  };

  const evict = () => {
    while (rows.size > maxSize) rows.delete(rows.keys().next().value);
  };

  const clone = (record) => record ? { ...record, data: record.data && typeof record.data === "object" ? { ...record.data } : record.data } : null;

  class Row {
    constructor(values) {
      Object.assign(this, values);
    }

    get() {
      return clone(this);
    }

    async update(values = {}) {
      Object.assign(this, values);
      touch(this);
      rows.delete(String(this[idField]));
      rows.set(String(this[idField]), this);
      evict();
      return this;
    }
  }

  return {
    get size() { return rows.size; },

    async findOne({ where = {} } = {}) {
      const id = where[idField] != null ? String(where[idField]) : null;
      if (id == null) return null;
      const row = rows.get(id);
      if (!row) return null;
      rows.delete(id);
      rows.set(id, row);
      return row;
    },

    async findAll({ attributes } = {}) {
      const out = [];
      for (const row of rows.values()) {
        if (Array.isArray(attributes) && attributes.length) {
          const picked = {};
          for (const key of attributes) if (key in row) picked[key] = row[key];
          out.push(new Row(picked));
        } else {
          out.push(row);
        }
      }
      return out;
    },

    async create(values = {}) {
      const id = String(values[idField]);
      const row = new Row({
        ...defaults,
        ...values,
        [idField]: id,
        createdAt: values.createdAt || new Date(),
        updatedAt: new Date(),
      });
      rows.delete(id);
      rows.set(id, row);
      evict();
      return row;
    },

    async destroy({ where = {} } = {}) {
      if (!Object.keys(where).length) {
        const count = rows.size;
        rows.clear();
        return count;
      }
      const id = where[idField] != null ? String(where[idField]) : null;
      return id != null && rows.delete(id) ? 1 : 0;
    },

    async increment(field, { by = 1, where = {} } = {}) {
      const id = where[idField] != null ? String(where[idField]) : null;
      if (id == null) return [0];
      const row = rows.get(id);
      if (!row) return [0];
      row[field] = Number(row[field] || 0) + Number(by || 0);
      touch(row);
      rows.delete(id);
      rows.set(id, row);
      return [1];
    },
  };
}

const User = makeModel({ idField: "userID", maxSize: MAX_USERS, defaults: { data: null } });
const Thread = makeModel({ idField: "threadID", maxSize: MAX_THREADS, defaults: { messageCount: 0, data: null } });

module.exports = {
  User,
  Thread,
  isReady: true,
  syncAll: async () => {},
};
