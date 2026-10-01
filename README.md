# AI Rover

A community-steered autonomous rover on procedurally generated Martian terrain.

**Live at [rover.s94.dev](https://rover.s94.dev)**

Nobody drives it. A Perseverance-class rover crawls across a fog-covered, procedurally generated Martian landscape at its real pace, up to 152 m per hour. While it rolls toward its next checkpoint, signed-in visitors pick where it should go after that, and like each other's proposals. When the drive ends, the best proposal wins: the server plans the route, simulates every wheel turn, and the rover sets off again. Every browser watches the same drive unfold, in 2D or 3D, and anyone can replay any part of the journey.

The slowness is the point. A drive lasts between 15 minutes and 2 hours, like the real one does.

## Autonomous driving, judged by Jev

The AI part is deliberately narrow. [TypeSafe](https://typesafe.ai)'s **Jev** is a judgment model, not a text generator: given a typed state, it returns typed answers (a probability, a level on a described scale) instead of prose. So the work is split by what each side is good at.

**Code owns everything that is arithmetic:**

- A seeded, chunked terrain generator with craters, slopes and loose ground, shared by server and browser.
- A line-of-sight viewshed from the rover's mast, so only ground the rover has actually seen gets revealed.
- An any-angle path planner over a cost map that knows slopes, loose ground and unseen terrain.
- A point-contact physics model of a six-wheel rocker-bogie rover, with its speed, tilt and slip limits.
- The drive itself: imaging stops, turns in place, replans when blocking ground appears, and safe stops short of the goal.

**Jev answers what arithmetic cannot.** Every proposed destination is planned, summarised in words, and evaluated by Jev with five questions:

| Question                                                      | Answer      |
| ------------------------------------------------------------- | ----------- |
| Can the rover realistically complete this segment as planned? | probability |
| How closely will the driven distance match the plan?          | 5 levels    |
| How closely will the drive time match the estimate?           | 5 levels    |
| How likely is the rover to be stopped or to fail?             | 4 levels    |
| How much new ground does this segment open?                   | 5 levels    |

The first answer becomes a verdict: unrealistic destinations are rejected before anyone can vote on them. The others weigh in on the winner: its score grows with the square root of its likes and up to double with the new ground it explores, with risk and confidence breaking ties. Levels describe situations in plain words rather than numbers, because Jev matches descriptions far better than it compares values.

Driving can fail. A slope too steep or a sand trap ends the attempt, and the rover returns to the checkpoint it started from, leaving a red ghost on the map. If the rover visibly stops moving, the community can flag it.

## Built with

### Nuxt 5

Built on the [Nuxt](https://nuxt.com) 5 nightly with [Nitro](https://nitro.build) v3 and [h3](https://h3.dev) v2. The terrain, planner, physics and mission rules live in `shared/`, so the exact same code runs on the server, which decides, and in the browser, which previews a plan before submitting it and replays drives locally. Sign-in with GitHub, Discord or Bluesky (AT Protocol) is built on [`unauth`](https://github.com/sandros94/unauth), [`unjwt`](https://github.com/sandros94/unjwt) and [`unsecure`](https://github.com/sandros94/unsecure), with sealed session cookies.

### Nuxt UI

The whole interface is [Nuxt UI](https://ui.nuxt.com), pushed well past forms and cards:

- **A full-viewport HUD.** Instruments float over the scene as draggable, resizable, minimisable windows, with a windows menu to show, hide or reset them. Layouts are remembered per browser. On phones they collapse into a bottom sheet.
- **Custom instruments.** Mission clock, speedometer and odometer, slip gauge, attitude indicator, reveal meter, planner telemetry and Jev's judgment cards are all composed from Nuxt UI primitives and restyled through their `ui` slots.
- **Themed, not forked.** One app config sets the palette, and a small set of CSS tokens adds an instrument palette checked for contrast in both light and dark mode.
- **Graphics settings.** Visitors pick a quality tier, or tune individual knobs, so the 3D scene runs on phones as well as desktops.

### TresJS

The 3D view is [TresJS](https://tresjs.org), declarative Three.js for Vue. It streams terrain in chunks around the current stop, lights it with a sun that follows the Martian day, and fades fog away as the rover's cameras see new ground. The rover is the real thing: NASA's Perseverance model, rigged with the joints from JPL's mobility model, so its wheels steer and its rocker-bogie suspension follows the ground as it drives. Checkpoints, past attempts and proposals are all clickable to inspect.

### Netlify

Hosted on [Netlify](https://netlify.com). Netlify Database (Postgres, via [Drizzle](https://orm.drizzle.team)) holds the live state: users, proposals, likes and rounds. Netlify Blobs behind the CDN hold the immutable journal: terrain packs, plans, keyframes and outcomes. A background function advances the mission, and Jev is currently billed through Netlify's AI Gateway.

## Development

```sh
pnpm install
cp .env.example .env
pnpm dev
```

Local development emulates Netlify, including the database, which migrates itself at boot. Every variable is documented in `.env.example`. Without a TypeSafe key, the app runs but cannot judge new proposals.

```sh
pnpm test        # unit, nuxt and e2e projects
pnpm typecheck
pnpm lint
```

## Credits

The rover model is built from [NASA's Perseverance 3D model](https://github.com/nasa/NASA-3D-Resources) and [JPL's Mars 2020 URDF models](https://github.com/nasa-jpl/m2020-urdf-models); credit NASA/JPL-Caltech. This project is not affiliated with or endorsed by NASA or JPL. See [model's CREDITS.md](./public/models/rover/CREDITS.md) for details.

## License

Published under the [MIT](./LICENSE) license.
