
let mongoClient = null;

let mongoDb = null;

let connectPromise = null;

const memory = new Map;

async function getMongoDb() {
    if (mongoDb) return mongoDb;
    if (connectPromise) return connectPromise;
    const uri = String(process.env.MONGO_URI || process.env.MONGODB_URI || "").trim();
    if (!uri) return null;
    connectPromise = (async () => {
        try {
            const {MongoClient: MongoClient} = await import("mongodb");
            mongoClient = new MongoClient(uri, {
                serverSelectionTimeoutMS: 8e3,
                connectTimeoutMS: 8e3
            });
            await mongoClient.connect();
            mongoDb = mongoClient.db(process.env.MONGO_DB_NAME || "sunkenbot");
            await mongoDb.command({
                ping: 1
            });
            return mongoDb;
        } catch (_) {
            try {
                await (mongoClient?.close());
            } catch (_) {}
            mongoClient = null;
            return null;
        } finally {
            connectPromise = null;
        }
    })();
    return connectPromise;
}

function key(collection, id) {
    return `${collection}::${id}`;
}

export async function loadCtx(collection, id, limit = 20) {
    const db = await getMongoDb();
    try {
        const row = await (db?.collection("ai_sessions").findOne({
            _id: key(collection, id)
        }));
        if (row) return (row.messages || []).slice(-limit);
    } catch (_) {}
    return (memory.get(key(collection, id)) || []).slice(-limit);
}

export async function saveCtx(collection, id, messages, limit = 20) {
    const idKey = key(collection, id);
    const sliced = messages.slice(-limit);
    memory.set(idKey, sliced);
    const db = await getMongoDb();
    try {
        await (db?.collection("ai_sessions").updateOne({
            _id: idKey
        }, {
            $set: {
                messages: sliced,
                updatedAt: new Date
            }
        }, {
            upsert: true
        }));
    } catch (_) {}
}

export async function clearCtx(collection, id) {
    const idKey = key(collection, id);
    memory.delete(idKey);
    const db = await getMongoDb();
    try {
        await (db?.collection("ai_sessions").deleteOne({
            _id: idKey
        }));
    } catch (_) {}
}

export const $plugin = {
    name: "xx-utils-shared-session",
    meta: {
        category: "utils",
        path: "utils/sharedSession.js"
    },
    setup: () => {}
};