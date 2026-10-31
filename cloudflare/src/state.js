// Durable Object ze stanem CrownLaunchera: jedna instancja ('main') trzyma dokumenty JSON (zaproszenia, klucze, gracze, ogłoszenia,
// sesje panelu) w synchronicznym storage.kv, a pliki leżą w R2. Cała logika żądań siedzi w app.js (port server/server.js).
import { DurableObject } from 'cloudflare:workers';
import { createApp } from './app.js';

export class CrownState extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.app = createApp({ kv: ctx.storage.kv, bucket: env.BUCKET, env });
  }

  fetch(request) {
    return this.app.handle(request);
  }
}
