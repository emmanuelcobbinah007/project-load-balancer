# project-load-balancer

> The best load balancer in the world.\*
>
> <sub>\*citation needed</sub>

I built this to learn and practice some of the system design stuff I've been studying, and also to feel something again. It's an HTTP load balancer written in TypeScript built from scratch, although claude helped out quite a bit Node's `http` module and a questionable amount of enthusiasm.

It won't replace nginx. It might replace your weekend.

## What it does

- **Distributes traffic with least connections.** Every request goes to the healthy server doing the least work right now, because not all requests are created equal and round robin doesn't know that.
- **Breaks ties fairly.** When servers are equally idle, they take turns instead of one server getting all the traffic.
- **Checks on its servers every 5 seconds.** It calls `GET /health` on every backend in parallel. Anything that doesn't answer within 500ms with a 2xx is marked `unhealthy` and gets no traffic until it recovers.
- **Keeps a diary.** Every health check result is written to a daily log file in `data/health-logs/`, one JSON line per check.
- **Tells backends who's really calling.** It adds an `X-Forwarded-For` header, so backends see the client's IP instead of just the load balancer's.
- **Fails politely.** It returns `503` when nobody is healthy, `502` when a backend breaks, and `504` when a backend takes too long.

## How it works

```
                          ┌──────────────┐
                     ┌───►│ backend 5001 │
┌────────┐   ┌───────┴──┐ └──────────────┘
│ client │──►│   load   │ ┌──────────────┐
└────────┘   │ balancer ├►│ backend 5002 │
             │  :3000   │ └──────────────┘
             └───────┬──┘ ┌──────────────┐
                     └───►│ backend 5003 │
                          └──────────────┘
```

1. A request comes in.
2. The balancer finds the healthy server with the fewest active jobs.
3. It adds 1 to that server's job count and streams the request to it.
4. It streams the response back to the client.
5. When the response closes (finished, failed, or the client gave up), it subtracts 1 from the job count.

Meanwhile, the health checker keeps checking every backend in the background.

## Getting started

```bash
npm install
```

Start some backends, each in its own terminal:

```bash
npm run backend -- 5001
npm run backend -- 5002
npm run backend -- 5003
```

Start the load balancer:

```bash
npm run dev
```

Register the backends:

```bash
curl -X POST localhost:3000/service/add-server \
  -H "Content-Type: application/json" \
  -d '{"serverName":"api-1","ipAddress":"127.0.0.1:5001"}'
```

Repeat for 5002 and 5003. Within 5 seconds they'll go from `unknown` to `healthy`, and you're load balancing.

Now go ahead and stop one of the backends with Ctrl+C. Watch it get marked `unhealthy`. Start it again and watch it come back.

## Playing with it

Anything not under `/service` is forwarded to a backend:

| Request             | What you get                                          |
| ------------------- | ----------------------------------------------------- |
| `GET /`             | A hello from whichever backend was chosen             |
| `GET /slow?ms=3000` | A slow job, handy for watching least connections work |
| `GET /broken`       | A backend that dies halfway through its response      |

The load balancer's own API lives under `/service`:

| Method   | Endpoint                     | What it does                                               |
| -------- | ---------------------------- | ---------------------------------------------------------- |
| `POST`   | `/service/add-server`        | Registers a backend. Body: `{ "serverName", "ipAddress" }` |
| `DELETE` | `/service/remove-server/:id` | Removes a backend. Its in-progress jobs still finish       |
| `GET`    | `/service/stats`             | Each server's health status and current job count          |

A Postman collection is included in [postman/](postman/). Import it and you're set.

**A fun experiment:** fire a couple of `/slow?ms=5000` requests, then spam `GET /`. The quick requests will avoid the busy servers and all go to the idle one. That's least connections doing its thing.

## Project layout

```
src/
  index.ts                  wires everything together
  proxy.ts                  forwards requests and streams responses back
  balancer/
    leastConnections.ts     picks the server and tracks job counts
    passiveHealth.ts        takes servers out after repeated failed requests
  healthChecker.ts          checks every backend every 5s
  healthLog.ts              writes the daily health log files
  serverRegistry.ts         add, remove and update servers
  db.ts                     reads and writes the JSON "database"
  controllers/              handlers for /service
  routes/                   routes for /service
backends/
  backend.ts                a tiny test backend with /health, /slow and /broken
```

## The "database"

It's a JSON file at `data/data.json`. In production this would be something like DynamoDB. Here it's a file, and we're at peace with that.

## What's next

- [x] **Passive health checks.** Stop sending traffic to a dead server after a few failed requests, instead of waiting up to 5 seconds for the next health check.
- [x] **Retries.** If a safe request (GET, HEAD, OPTIONS) fails to reach one server, try another before giving the client an error.
- [ ] **Weighted distribution.** Bigger servers get more traffic, using weighted least connections with smooth weighted round-robin to break ties.
- [ ] **Keep the server list in memory** instead of reading the JSON file on every request.

## Things I learned along the way

- A dead server fails in about 1ms, so to least connections it looks like the least busy server. Left alone, it attracts traffic.
- The load balancer doesn't need the client's IP to route the response back. The response returns on the same connection the request came in on.
- Some headers (`connection`, `keep-alive`, `transfer-encoding`) only apply to one connection and must be removed before forwarding.
- `res.on("close")` fires exactly once per response, whatever happened, which makes it the one reliable place to decrease a job count.
- Feeling something again is easier than debugging `Promise.all` at 2am.

## License

ISC. Do whatever you want with it. If it breaks, you get to keep both pieces.
