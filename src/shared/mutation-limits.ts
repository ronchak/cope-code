/**
 * Maximum size of one file handled by the cross-platform pinned mutation
 * protocol. Keep configuration validation, staging, and rollback on the same
 * explicit compatibility boundary.
 */
export const MAX_MUTATION_FILE_BYTES = 16 * 1024 * 1024;
