# Third-party code

`vendor/hindsight-coding-agents` contains the DSH runtime and its companion scripts
from `@vectorize-io/hindsight-coding-agents` version 0.8.7, maintained by Vectorize AI.
Upstream: https://github.com/vectorize-io/hindsight/tree/main/hindsight-integrations/coding-agents

The upstream MIT license is preserved in that directory. The original package
metadata is retained as `upstream-package.json`. Bundled third-party notices at the
end of the distributed JavaScript files are preserved, including smol-toml's BSD
license text.

The vendored `dist/dsh.js` includes local changes for DSH 0.2.2-rc.1: the Agent
creation event, request-series preservation, instance-owned runtime caches,
configuration refresh, disposal, and caller cancellation. The companion scripts
and skill are unchanged. The upstream package is distributed as prebuilt code;
this repository does not claim to contain its original TypeScript build tree.

The manager imports this local runtime directly. It does not download or overwrite
the vendored code during installation. The upstream sync workflow uses
`upstream-sync.json` and `patches/hindsight-dsh.patch` to prepare updates in a pull
request after the regression and packaging tests pass. Conflicting upstream changes
require porting the patch. License changes and server compatibility are reviewed
before merging; the existing upstream MIT license is preserved during synchronization.
