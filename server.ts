// Local plugin directories are resolved by probing `server` before `index`.
// A missing entrypoint raises Bun's ResolveMessage, which skips the host's
// extension fallback, so directory discovery fails without this re-export.
export { default } from "./index"
