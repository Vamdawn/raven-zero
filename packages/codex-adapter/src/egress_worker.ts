import {z} from 'zod';
import {writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {sync} from './native.js';
import {startEgress} from './egress.js';

// Executed only by the trusted native activation helper, outside Agent scope.
const descriptor = z.coerce.number().int().nonnegative().parse(process.env.RAVEN_EGRESS_FD);
const relay = await startEgress(process.env.RAVEN_EGRESS_UPSTREAM || undefined, descriptor);
const ready = join(process.cwd(), 'ready.json');
await writeFile(ready, JSON.stringify({port: relay.port}), {flag: 'wx', mode: 0o600});
await sync(ready); await sync(process.cwd()); await sync(ready);
