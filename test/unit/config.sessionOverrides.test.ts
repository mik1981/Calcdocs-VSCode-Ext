import { describe, it, afterEach } from "vitest";
import assert from "node:assert/strict";

import {
  getConfig,
  setSessionConfigOverride,
  clearSessionConfigOverride,
  hasSessionConfigOverride,
} from "../../src/core/config";

describe("config.ts — override di sessione per scritture fallite", () => {
  // La Map è a livello di modulo: ripulisci sempre, per non "sporcare"
  // i test successivi.
  afterEach(() => {
    clearSessionConfigOverride("enabled");
    clearSessionConfigOverride("scanInterval");
    clearSessionConfigOverride("inline.ghost.enabled");
  });

  it("senza override, getConfig() riflette il valore normale", () => {
    assert.equal(hasSessionConfigOverride("enabled"), false);
    assert.equal(typeof getConfig().enabled, "boolean");
  });

  it("un override di sessione viene applicato SOPRA il valore letto normalmente", () => {
    const before = getConfig().enabled;

    setSessionConfigOverride("enabled", (cfg) => {
      cfg.enabled = !before;
    });

    assert.equal(hasSessionConfigOverride("enabled"), true);
    assert.equal(
      getConfig().enabled,
      !before,
      "getConfig() deve riflettere l'override, non il valore originale"
    );
  });

  it("un override sopravvive a chiamate multiple di getConfig() (non è una patch una-tantum)", () => {
    setSessionConfigOverride("scanInterval", (cfg) => {
      cfg.scanInterval = 999;
    });

    assert.equal(getConfig().scanInterval, 999);
    assert.equal(getConfig().scanInterval, 999, "deve restare applicato anche alla seconda chiamata");
    assert.equal(getConfig().scanInterval, 999, "e alla terza");
  });

  it("clearSessionConfigOverride rimuove l'override, tornando al valore normale", () => {
    const before = getConfig().enabled;
    setSessionConfigOverride("enabled", (cfg) => {
      cfg.enabled = !before;
    });
    assert.equal(getConfig().enabled, !before);

    clearSessionConfigOverride("enabled");

    assert.equal(hasSessionConfigOverride("enabled"), false);
    assert.equal(getConfig().enabled, before, "senza override deve tornare al valore originale");
  });

  it("registrare un nuovo override per la STESSA chiave sostituisce, non accumula, quello precedente", () => {
    setSessionConfigOverride("scanInterval", (cfg) => {
      cfg.scanInterval = 111;
    });
    assert.equal(getConfig().scanInterval, 111);

    setSessionConfigOverride("scanInterval", (cfg) => {
      cfg.scanInterval = 222;
    });
    assert.equal(
      getConfig().scanInterval,
      222,
      "il secondo override deve sostituire il primo, non sommarsi"
    );
  });

  it("override su chiavi diverse convivono senza interferire tra loro", () => {
    setSessionConfigOverride("enabled", (cfg) => {
      cfg.enabled = false;
    });
    setSessionConfigOverride("scanInterval", (cfg) => {
      cfg.scanInterval = 42;
    });

    const config = getConfig();
    assert.equal(config.enabled, false);
    assert.equal(config.scanInterval, 42);
  });
});
