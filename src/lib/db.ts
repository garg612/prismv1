import {PrismaClient} from "@/generated/prisma/client"
import {PrismaPg} from "@prisma/adapter-pg"

// Extend connect timeout for Neon free-tier cold starts (default 5s is too short)
const dbUrl = process.env.DATABASE_URL || "";
const connectionString = dbUrl.includes("?")
    ? `${dbUrl}&connect_timeout=30`
    : `${dbUrl}?connect_timeout=30`;

// Opening a connection to the database costs about 2 seconds; a query on an open one about 0.2.
// The pool's default drops idle connections after 10 seconds, so every pipeline step that follows
// a scan, a model call or a sandbox run paid that 2 seconds again, and parallel queries each
// opened their own. Keep connections open between steps, below the server's own 5-minute idle limit.
const POOL_MAX = parseInt(process.env.DATABASE_POOL_MAX || "10", 10);
const POOL_IDLE_MS = parseInt(process.env.DATABASE_POOL_IDLE_MS || "240000", 10);

const adapter=new PrismaPg({
    connectionString,
    max: POOL_MAX,
    idleTimeoutMillis: POOL_IDLE_MS,
    // A connection the server closed while idle must not fail the next query
    keepAlive: true,
    // Idle connections must not keep a script alive once it has finished its work
    allowExitOnIdle: true,
})

const prismaClientSingleton=()=>{
    return new PrismaClient({
        adapter
    })
}

// In development the client is kept across hot reloads. It is rebuilt when the pool settings change,
// so a new setting takes effect without restarting the dev server. It is also rebuilt after
// `prisma generate`: a client made from the previous schema does not know new fields or indexes,
// and every query that uses them would fail until the server was restarted.
const poolSettings = `${POOL_MAX}:${POOL_IDLE_MS}`;

declare const globalThis:{
    prismaGlobal?:ReturnType<typeof prismaClientSingleton>
    prismaGlobalPoolSettings?:string
}& typeof global

const cached = globalThis.prismaGlobal
const reusable = globalThis.prismaGlobalPoolSettings===poolSettings && cached instanceof PrismaClient

export const prisma=(reusable && cached) || prismaClientSingleton()

if(process.env.NODE_ENV!=='production'){
    globalThis.prismaGlobal=prisma
    globalThis.prismaGlobalPoolSettings=poolSettings
}

export default prisma
