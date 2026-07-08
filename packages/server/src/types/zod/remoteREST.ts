import { z } from "zod";

import { RemoteRESTConfigZod } from "../../config/types/remote-rest";

export { RemoteRESTConfigZod };

/** Runtime (z.output) type for remote REST config */
export type RemoteRESTConfig = z.output<typeof RemoteRESTConfigZod>;
