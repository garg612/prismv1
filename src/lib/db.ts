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

const poolSettings = `${POOL_MAX}:${POOL_IDLE_MS}`;

declare const globalThis: {
    prismaGlobal?: PrismaClient
    prismaGlobalAdapter?: PrismaPg
    prismaGlobalPoolSettings?: string
} & typeof global

const cachedAdapter = globalThis.prismaGlobalAdapter
const cached = globalThis.prismaGlobal
const reusable = globalThis.prismaGlobalPoolSettings === poolSettings && cached instanceof PrismaClient && cachedAdapter instanceof PrismaPg

const adapter = (reusable && cachedAdapter) ? cachedAdapter : new PrismaPg({
    connectionString,
    max: POOL_MAX,
    idleTimeoutMillis: POOL_IDLE_MS,
    keepAlive: true,
    allowExitOnIdle: true,
});

const prismaClientSingleton = () => {
    return new PrismaClient({ adapter })
}

export const prisma = (reusable && cached) ? cached : prismaClientSingleton()

if (process.env.NODE_ENV !== 'production') {
    globalThis.prismaGlobal = prisma
    globalThis.prismaGlobalAdapter = adapter
    globalThis.prismaGlobalPoolSettings = poolSettings
}


export default prisma
