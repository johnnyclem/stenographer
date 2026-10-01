// Lets a child `node` process import the TypeScript sources directly (with
// --experimental-transform-types): relative `.js` specifiers from a `.ts`
// module resolve to the `.ts` file beside them, as the bundler resolution
// in tsconfig does. For tests that need real separate processes.
import { registerHooks } from 'node:module';

registerHooks({
  resolve(specifier, context, next) {
    if (specifier.startsWith('.') && specifier.endsWith('.js') && context.parentURL?.endsWith('.ts')) {
      try {
        return next(`${specifier.slice(0, -3)}.ts`, context);
      } catch {
        // Not a TypeScript source: resolve as written
      }
    }
    return next(specifier, context);
  },
});
