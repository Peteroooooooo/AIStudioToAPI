const { ModelCatalogError } = require("../utils/ModelCatalogStore");
const FormatConverter = require("../core/FormatConverter");

class ModelRoutes {
    constructor(serverSystem) {
        this.serverSystem = serverSystem;
        this.catalog = serverSystem.modelCatalogStore;
        this.logger = serverSystem.logger;
    }

    setupRoutes(app, isAuthenticated) {
        const handleError = (res, error) => {
            if (error instanceof ModelCatalogError) {
                return res.status(error.status || 400).json({ error: error.message });
            }
            this.logger.error(`[Models] Management request failed: ${error.message}`);
            return res.status(500).json({ error: "Model catalog operation failed." });
        };
        const noStore = (_req, res, next) => {
            res.set("Cache-Control", "no-store");
            next();
        };

        app.get("/api/models/catalog", isAuthenticated, noStore, (_req, res) => {
            res.status(200).json(this.catalog.getAdminState());
        });
        app.get("/api/models/probe-accounts", isAuthenticated, noStore, (_req, res) => {
            const accounts = this.serverSystem.authSource.getRotationIndices().map(index => ({
                connected: this.serverSystem.connectionRegistry.getConnectionByAuth(index, false)?.readyState === 1,
                index,
            }));
            res.status(200).json({ accounts, currentIndex: this.serverSystem.browserManager.currentAuthIndex });
        });
        app.post("/api/models/catalog", isAuthenticated, noStore, async (req, res) => {
            try {
                return res.status(201).json(await this.catalog.addModel(req.body));
            } catch (error) {
                return handleError(res, error);
            }
        });
        app.post("/api/models/sync", isAuthenticated, noStore, async (req, res) => {
            try {
                return res.status(200).json(await this.catalog.syncCatalog(req.body || {}));
            } catch (error) {
                return handleError(res, error);
            }
        });
        app.post("/api/models/:id/probe", isAuthenticated, noStore, async (req, res) => {
            const model = this.catalog.getAdminState().models.find(entry => entry.id === req.params.id);
            if (!model) return res.status(404).json({ error: "Model not found." });
            if (!model.probeSupported) {
                return res.status(422).json({ error: "This model does not support a text generation probe." });
            }
            const accountIndex = req.body?.authIndex ?? this.serverSystem.browserManager.currentAuthIndex;
            if (
                !Number.isInteger(accountIndex) ||
                !this.serverSystem.authSource.getRotationIndices().includes(accountIndex)
            ) {
                return res.status(400).json({ error: "Choose an available account." });
            }
            if (this.serverSystem.connectionRegistry.getConnectionByAuth(accountIndex, false)?.readyState !== 1) {
                return res.status(409).json({ error: "This account is not connected. Open it from Accounts first." });
            }

            const body = {
                contents: [{ parts: [{ text: "Reply with OK only." }], role: "user" }],
                generationConfig: { maxOutputTokens: 128 },
            };
            try {
                const thinkingConfig = FormatConverter.resolveThinkingConfig({
                    forceThinking: this.serverSystem.config.forceThinking,
                    managedPolicy: model.enabled ? this.catalog.getEffectiveThinkingPolicy(model.id) : null,
                    modelName: model.id,
                });
                if (thinkingConfig) body.generationConfig.thinkingConfig = thinkingConfig;
                await this.serverSystem.requestHandler.cacheManager._resourceRequest(accountIndex, {
                    body,
                    method: "POST",
                    path: `/v1beta/models/${model.id}:generateContent`,
                });
                await this.catalog.recordProbe(model.id, String(accountIndex), { status: "available" });
                return res.status(200).json({ accountIndex, status: "available" });
            } catch (error) {
                const httpStatus = Number.isInteger(error.status) ? error.status : null;
                const status = httpStatus === 404 ? "unavailable" : "unknown";
                try {
                    await this.catalog.recordProbe(model.id, String(accountIndex), { httpStatus, status });
                } catch (saveError) {
                    return handleError(res, saveError);
                }
                return res.status(200).json({ accountIndex, httpStatus, status });
            }
        });
        app.patch("/api/models/:id", isAuthenticated, noStore, async (req, res) => {
            try {
                return res.status(200).json(await this.catalog.updatePolicy(req.params.id, req.body));
            } catch (error) {
                return handleError(res, error);
            }
        });
    }
}

module.exports = ModelRoutes;
