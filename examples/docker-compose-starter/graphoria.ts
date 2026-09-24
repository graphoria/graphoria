import type { ConfigurationFn } from "@graphoria/server/config";

export default (({ operation, z }) => ({
  name: "docker-compose-starter",
  version: "1.0.0",
  databases: [
    {
      name: "main",
      type: "pg",
      enabled: true,
      connection: {
        // `postgres` inside Docker Compose, `localhost` when run on the host.
        host: process.env.PG_HOST ?? "localhost",
        port: 5432,
        user: "postgres",
        password: "postgres",
        database: "my_app",
      },
    },
  ],
  operations: {
    booksByAuthor: operation({
      description: "Books by one author, newest first",
      query: `
        query BooksByAuthor($authorId: Int!) {
          books: public_books(
            where: { author_id: { eq: $authorId } }
            orderBy: { published_year: DESC }
          ) {
            id
            title
            published_year
          }
        }
      `,
      rest: {
        path: "/authors/:authorId/books",
        method: "GET",
        // Path params arrive as strings; coerce to match `Int!`.
        pathParams: z.object({ authorId: z.coerce.number().int() }),
      },
    }),
  },
})) satisfies ConfigurationFn;
