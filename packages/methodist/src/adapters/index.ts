// §12.7 schema-driven adapters — pure functions that turn a record + its record_schema
// into the graph node-mapping / embed projection+payload / read view. Driven by the data
// invariants I1 (attester = led agent) / I2 (read ≤ written) / I3 (GO vs RETURN write-set).
export * from './read-projection.js';
export * from './graph-mapping.js';
export * from './embed.js';
