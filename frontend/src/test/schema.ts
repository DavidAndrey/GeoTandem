// The exported query-object schema as the judge of every query the UI builds.
import Ajv2020 from 'ajv/dist/2020'
import schema from '../../../schema/query-object/v1.json'

// Pydantic writes OpenAPI's "discriminator"; not a JSON-Schema keyword.
const validate = new Ajv2020({ strict: false, allErrors: true }).compile(schema)

/** Throws with the schema's complaint if ``query`` is not a valid v1 query object. */
export function assertValidQuery(query: unknown): void {
  if (!validate(query))
    throw new Error(
      `invalid query object: ${JSON.stringify(validate.errors?.slice(0, 3))}\n${JSON.stringify(query)}`,
    )
}
