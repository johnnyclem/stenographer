// A module hook that refuses to load better-sqlite3: `node --import
// ./test/helpers/forbid-sqlite.mjs -e "await import('./dist/truth-format.js')"`
// proves the truth-format subpath loads in a process where the SQLite
// driver cannot (stenographer PRD R8). CI runs it after the build.
import { register } from 'node:module';

register(
  'data:text/javascript,' +
    encodeURIComponent(`
      export async function resolve(specifier, context, next) {
        if (specifier === 'better-sqlite3' || specifier.includes('/better-sqlite3/')) {
          throw new Error('better-sqlite3 must not load from the truth-format subpath: ' + specifier + ' from ' + context.parentURL);
        }
        return next(specifier, context);
      }
    `)
);
