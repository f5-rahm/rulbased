'use strict';

/**
 * index.js
 *
 * restnoded scans all .js files in the nodejs/ directory tree and attempts
 * to instantiate each as a worker constructor. It does NOT use require()
 * on this file to load workers — it finds them by scanning individually.
 *
 * Each worker file (configProcessor.js, rulesWorker.js, settingsWorker.js)
 * exports its own constructor directly and is loaded automatically by the
 * scanner. This file intentionally exports nothing to avoid the
 * "WorkerDef is not a constructor" warning that occurs when restnoded
 * tries to instantiate a non-constructor export.
 *
 * Workers registered by this package:
 *   - lib/configProcessor.js  -> /mgmt/shared/iapp/processors/rulbased
 *   - lib/rulesWorker.js      -> /mgmt/shared/rulbased/rules
 *   - lib/settingsWorker.js   -> /mgmt/shared/rulbased/settings
 *   - lib/uiWorker.js         -> /mgmt/shared/rulbased/ui
 */
