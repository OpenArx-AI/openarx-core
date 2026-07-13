// ── Primitive registry (runtime §1) ──────────────────────────────────────────
//
// id → { version → (impl, passport) }. Multiple versions coexist; resolve
// returns the EXACT requested version. Choosing a version to fit surrounding
// wiring is the methodology's job, not the runtime's. Unknown id/version is a
// hard error (rejected), never a "returned".

import { RuntimeError } from './outcomes.js';
import type { Passport } from './passport.js';
import type { Registration } from './primitive.js';

export class Registry {
  private readonly byId = new Map<string, Map<string, Registration>>();

  /** Declarative registration from a primitive manifest. */
  register(reg: Registration): void {
    const { id, version } = reg.passport;
    let versions = this.byId.get(id);
    if (!versions) {
      versions = new Map<string, Registration>();
      this.byId.set(id, versions);
    }
    if (versions.has(version)) {
      throw new RuntimeError('internal', `duplicate registration for ${id}@${version}`);
    }
    versions.set(version, reg);
  }

  registerAll(regs: readonly Registration[]): void {
    for (const reg of regs) this.register(reg);
  }

  resolve(id: string, version: string): Registration {
    const versions = this.byId.get(id);
    if (!versions) throw new RuntimeError('unknown-primitive', `no primitive '${id}'`);
    const reg = versions.get(version);
    if (!reg) throw new RuntimeError('unknown-version', `primitive '${id}' has no version '${version}'`);
    return reg;
  }

  has(id: string, version: string): boolean {
    return this.byId.get(id)?.has(version) ?? false;
  }

  /** All registered passports (for observability / manifests). */
  list(): Passport[] {
    const out: Passport[] = [];
    for (const versions of this.byId.values()) {
      for (const reg of versions.values()) out.push(reg.passport);
    }
    return out;
  }
}
