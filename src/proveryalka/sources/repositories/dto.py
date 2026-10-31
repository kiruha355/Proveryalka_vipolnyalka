from pydantic import Field, StrictInt, StrictStr, model_validator

from ...contracts import Contract, Source


class RepositoryImport(Contract):
    remote_url: StrictStr = Field(min_length=1, max_length=500)
    ref: StrictStr = Field(default="HEAD", min_length=1, max_length=200)
    credential_ref: StrictStr | None = Field(default=None, min_length=1, max_length=100)


class RepositoryRefresh(Contract):
    ref: StrictStr = Field(default="HEAD", min_length=1, max_length=200)
    credential_ref: StrictStr | None = Field(default=None, min_length=1, max_length=100)


class RepositoryFile(Contract):
    path: str
    sha256: str = Field(pattern=r"^[a-f0-9]{64}$")
    size_bytes: int
    lines: int
    provenance_url: str


class RepositorySnapshot(Contract):
    id: str
    session_id: str
    remote_url: str
    commit_sha: str
    manifest_sha256: str
    parent_snapshot_id: str | None
    created_at: str
    files: list[RepositoryFile]
    excluded: dict[str, int]
    policy_version: str


class RepositoryRange(Contract):
    path: StrictStr = Field(min_length=1, max_length=1000)
    sha256: StrictStr = Field(pattern=r"^[a-f0-9]{64}$")
    start_line: StrictInt = Field(ge=1)
    end_line: StrictInt = Field(ge=1)

    @model_validator(mode="after")
    def ordered(self):
        if self.end_line < self.start_line:
            raise ValueError("end_line must be at least start_line")
        return self


class RepositorySelection(Contract):
    manifest_sha256: StrictStr = Field(pattern=r"^[a-f0-9]{64}$")
    files: list[RepositoryRange] = Field(min_length=1, max_length=20)


class RepositoryExcerpt(RepositoryRange):
    text: str
    provenance_url: str
    source_start: int
    source_end: int


class RepositoryContext(Contract):
    snapshot_id: str
    commit_sha: str
    manifest_sha256: str
    excerpts: list[RepositoryExcerpt]
    source: Source
