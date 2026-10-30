import hashlib
from pathlib import Path

from fastapi.responses import Response
from ..checker.artifacts import ArtifactError, RunBundle
from ..services import ServiceError


class ArtifactAPI:
    def __init__(self, store, root):
        self.store = store
        self.root = Path(root) / "checks"

    def _bundle(self, run_id):
        with self.store.transaction() as connection:
            row = self.store._run(connection, run_id)
            if row["kind"] != "check":
                raise ServiceError(404, "NOT_FOUND", "Check not found")
            if row["state"] in ("queued", "running", "cancelling"):
                raise ServiceError(409, "CHECK_PENDING", "Check has not finished")
            if not row["artifacts"]:
                raise ServiceError(404, "ARTIFACT_NOT_FOUND", "No diagnostic bundle")
            version = connection.execute("SELECT spec_hash FROM model_versions WHERE id=?", (row["version_id"],)).fetchone()
        bundle = RunBundle(self.root, run_id)
        # A symlinked run directory must not redirect into another run or outside root.
        if bundle.path.is_symlink() or bundle.path.resolve() != bundle.path:
            raise ArtifactError("Invalid bundle directory")
        manifest = bundle.manifest()
        if manifest.get("run_id") != run_id or manifest.get("version_id") != row["version_id"] or manifest.get("spec_hash") != version["spec_hash"]:
            raise ArtifactError("Bundle belongs to another run/version")
        return bundle, manifest

    def list_artifacts(self, run_id):
        try:
            _, manifest = self._bundle(run_id)
            return manifest["files"]
        except (OSError, ValueError, KeyError, TypeError) as error:
            raise ServiceError(404, "ARTIFACT_NOT_FOUND", "Diagnostic bundle unavailable") from error

    def get_artifact(self, run_id, name):
        try:
            bundle, manifest = self._bundle(run_id)
            if not name or "\\" in name or any(part in (".", "..", "") for part in name.split("/")) or name.startswith("/"):
                raise ArtifactError("Invalid name")
            entry = next((f for f in manifest["files"] if f["name"] == name), None)
            if entry is None:
                raise ArtifactError("Unknown artifact")
            path = bundle.open(name)
            # Read once and return the verified bytes, avoiding FileResponse's later reopen.
            data = path.read_bytes()
            if len(data) != entry["size"] or hashlib.sha256(data).hexdigest() != entry["sha256"]:
                raise ArtifactError("Artifact changed")
            return Response(data, media_type="application/octet-stream", headers={"X-Content-Type-Options":"nosniff"})
        except (OSError, ValueError, KeyError, TypeError) as error:
            raise ServiceError(404, "ARTIFACT_NOT_FOUND", "Diagnostic file unavailable") from error
