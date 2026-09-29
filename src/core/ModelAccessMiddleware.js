const DEFAULT_GENERATION_MODEL = "gemini-2.5-flash-lite";
const DEFAULT_MODEL_PATHS = new Set([
    "/v1/chat/completions",
    "/v1/responses",
    "/v1/responses/input_tokens",
    "/responses/input_tokens",
    "/v1/messages",
    "/v1/messages/count_tokens",
]);

function createModelAccessMiddleware(catalogStore) {
    return (req, res, next) => {
        const reject = () =>
            res.status(404).json({
                error: {
                    code: "model_not_found",
                    message: "The requested model is not available.",
                    type: "invalid_request_error",
                },
            });

        const resolve = rawModel => {
            if (typeof rawModel !== "string" || !rawModel.trim()) return null;
            const input = rawModel.trim();
            const model = catalogStore.resolveRequestModel(input);
            if (!model) return null;
            const prefix = /^models\//i.test(input) ? "models/" : "";
            return `${prefix}${model.upstreamId}${model.suffix}`;
        };

        const rewriteField = (object, key) => {
            if (!object || typeof object[key] !== "string") return true;
            const upstreamModel = resolve(object[key]);
            if (!upstreamModel) return false;
            object[key] = upstreamModel;
            return true;
        };

        const path = req.path || req.url?.split("?", 1)[0] || "";
        if (path === "/v1/models" || path === "/v1beta/models") return next();

        const pathMatch = path.match(/^\/(?:proxy\/)?v1(?:beta)?\/models\/([^/:?]+)(?::|$)/);
        if (pathMatch) {
            const upstreamModel = resolve(decodeURIComponent(pathMatch[1]));
            if (!upstreamModel) return reject();
            const encoded = encodeURIComponent(upstreamModel.replace(/^models\//, ""));
            req.url = req.url.replace(pathMatch[1], encoded);
        }

        const body = req.body;
        if (body && typeof body === "object") {
            if (!rewriteField(body, "model")) return reject();
            if (!rewriteField(body.generateContentRequest, "model")) return reject();
            if (Array.isArray(body.requests)) {
                for (const request of body.requests) {
                    if (!rewriteField(request, "model")) return reject();
                }
            }
        }

        if (!pathMatch && DEFAULT_MODEL_PATHS.has(path) && !body?.model) {
            if (!catalogStore.resolveRequestModel(DEFAULT_GENERATION_MODEL)) return reject();
        }
        return next();
    };
}

module.exports = { createModelAccessMiddleware };
