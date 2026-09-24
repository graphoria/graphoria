# graphoria

The Graphoria command-line interface. The CLI itself ships in
[`@graphoria/server`](https://www.npmjs.com/package/@graphoria/server); this package gives it the
unscoped name, so it runs in an empty directory:

```bash
bunx graphoria init
```

`init` scaffolds a Graphoria project with Docker Compose in the current directory. It is the same
command as `bunx @graphoria/server init`.

Start with the [Quickstart](https://github.com/graphoria/graphoria/blob/main/docs/QUICKSTART.md).
