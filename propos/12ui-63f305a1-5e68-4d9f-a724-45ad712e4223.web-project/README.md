# Generated React project

This project handoff was generated from the canonical LayerDoc responsive web presentation.

Assets are included in `public/assets/`, the static source directory for this target. Keep that directory in place: the target's dev and build commands publish it at the generated `/assets/*` URLs.

## Integration surface

- `src/main.tsx`
- `index.html`
- `vite.config.ts`
- `package.json`
- `public/assets/7904600e5a01a62102bf.png`
- `public/assets/b2b718898b7641e8c9ed.svg`
- `public/assets/7ffe07c485b8841eb791.svg`
- `public/assets/346682c42f2136077b28.svg`
- `public/assets/b254f6a27aafcf566a0b.svg`
- `public/assets/09ad517ee17626e16359.svg`
- `public/assets/be5bf9aed8bdec452aad.svg`
- `public/assets/eb43a23b94f8ec885458.png`
- `public/assets/69b9bbddaa4ae0a4fd17.svg`
- `public/assets/fe3c07fd1eb4e08ec6cc.png`
- `public/assets/832138220e32bd328636.png`
- `public/assets/7d8a4441ea4b1c4ed172.png`
- `public/assets/1e5aa9035ee676597324.png`
- `public/assets/454c0c5464d8a0e971b3.png`
- `public/assets/ab482b4dbad9036eb272.png`
- `public/assets/286e44c7a878411d2868.png`
- `public/assets/c8f9bf5a772427327f62.png`
- `public/assets/4e13f629c5d3efe86bad.png`
- `public/assets/d21d9cc0ad7cea5e195a.png`
- `public/assets/d48fb2cb818055a2cb5b.png`
- `public/assets/5c7a4c0a3378d6dc2982.svg`
- `public/assets/af71da5c655c151dc5f6.svg`
- `public/assets/f3f1f04ac0797509667f.png`
- `public/assets/7ffecd2130b6abea8dce.png`
- `public/assets/bb2628b8d5427db3194f.png`
- `public/assets/590676045c3098a860a4.png`
- `public/assets/f703b5f46d8b457bdcde.png`
- `public/assets/a1b511b6fdacc9c86855.png`
- `public/assets/e275dfd4368abe6f825e.png`
- `public/assets/1435f4041a60cb436295.png`
- `public/assets/ca907a65f56e30ee53a9.png`
- `public/assets/1e217416a1c80d4ba452.png`
- `public/assets/374832ad608d3ebd1caa.png`
- `public/assets/22b4ef62a8d45f5fe147.png`
- `public/assets/5a26269797978e802f09.png`
- `public/assets/f04fdee15a9161a6d23a.png`
- `public/assets/a55690f2ae2ea48d56af.png`
- `public/assets/e55459ee7a09019bde87.svg`
- `public/assets/e2949feefdc7a6c99f81.svg`
- `public/assets/db0fc9ddf191206599cc.svg`
- `public/assets/effe8a1a375b925da958.png`
- `public/assets/2b0e8077f5f04cbd5e7e.png`
- Action contract: `src/generated-actions.ts`

Run the host and listen for `12ui:action` on `document`.

This archive includes the complete runnable host scaffold. The host bridges every unresolved control to a bubbling, composed `12ui:action` `CustomEvent`; it does not invent navigation or application behavior.

See `interactions.json` for the exact unresolved action IDs and reasons.

## Verify

```sh
pnpm install
```

```sh
pnpm typecheck
```

```sh
pnpm build
```
