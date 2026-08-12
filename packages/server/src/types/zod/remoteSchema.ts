import { z } from "zod";

import {
  RemoteSchemaConfigZod,
  RemoteSchemaIntrospectionConfigZod,
} from "../../config/types/remote-schema";

export { RemoteSchemaConfigZod, RemoteSchemaIntrospectionConfigZod };

/** Runtime (z.output) type for remote schema config */
export type RemoteSchemaConfig = z.output<typeof RemoteSchemaConfigZod>;
