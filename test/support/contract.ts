import { readFileSync } from 'node:fs';
import { Ajv2020 } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { parse } from 'yaml';

/**
 * Validates response bodies against contracts/openapi.yaml component schemas.
 * Ajv's 2020-12 dialect matches OpenAPI 3.1 (e.g. `type: [string, 'null']`).
 */
const doc = parse(readFileSync(new URL('../../contracts/openapi.yaml', import.meta.url), 'utf8'));
const ajv = new Ajv2020({ strict: false, allErrors: true });
addFormats.default(ajv);
ajv.addFormat('binary', true);
ajv.addSchema({ $id: 'openapi', components: doc.components });

/** Server→client event payloads from contracts/ws-events.schema.json. */
const ws = JSON.parse(
  readFileSync(new URL('../../contracts/ws-events.schema.json', import.meta.url), 'utf8'),
) as { $id: string };
ajv.addSchema(ws);

export function expectEvent(event: string, payload: unknown) {
  const validate = ajv.compile({
    $ref: `${ws.$id}#/$defs/server-to-client/properties/${encodeURIComponent(event)}`,
  });
  if (!validate(payload)) {
    throw new Error(
      `Event ${event} does not match ws-events schema:\n` +
        ajv.errorsText(validate.errors, { separator: '\n' }) +
        `\npayload: ${JSON.stringify(payload, null, 2)}`,
    );
  }
}

export function expectContract(schemaName: string, body: unknown, opts: { array?: boolean } = {}) {
  const ref = { $ref: `openapi#/components/schemas/${schemaName}` };
  const schema = opts.array ? { type: 'array', items: ref } : ref;
  const validate = ajv.compile(schema);
  if (!validate(body)) {
    throw new Error(
      `Response does not match ${schemaName}${opts.array ? '[]' : ''}:\n` +
        ajv.errorsText(validate.errors, { separator: '\n' }) +
        `\nbody: ${JSON.stringify(body, null, 2)}`,
    );
  }
}
