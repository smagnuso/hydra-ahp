# hydra-ahp

Serve [Hydra](https://github.com/smagnuso/hydra-acp) sessions to Agent Host
Protocol (AHP) clients such as VS Code's agent UI. Runs as a Hydra extension:
AHP over WebSocket upstream, Hydra's `/acp` and `/v1/*` downstream.

Work in progress; nothing is usable yet.

## Development

```
npm install
npm run build
npm test
npm run lint
```

## License

MIT
