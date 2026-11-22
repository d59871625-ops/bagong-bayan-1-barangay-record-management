<?php

function bb1EnsureResidentRequestChangesTable(PDO $pdo): void
{
    static $ensured = false;
    if ($ensured) {
        return;
    }

    $pdo->exec("
        CREATE TABLE IF NOT EXISTS bb1_resident_request_changes (
            request_id VARCHAR(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL PRIMARY KEY,
            data_value LONGTEXT NULL,
            is_deleted TINYINT(1) NOT NULL DEFAULT 0,
            updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
                ON UPDATE CURRENT_TIMESTAMP
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    ");
    $ensured = true;
}

function bb1EnsureSyncRevisionTable(PDO $pdo): void
{
    static $ensured = false;
    if ($ensured) {
        return;
    }

    $pdo->exec("
        CREATE TABLE IF NOT EXISTS bb1_sync_revision (
            revision_id TINYINT UNSIGNED NOT NULL PRIMARY KEY,
            revision BIGINT UNSIGNED NOT NULL DEFAULT 0
        ) ENGINE=InnoDB
    ");
    $pdo->exec("INSERT IGNORE INTO bb1_sync_revision (revision_id, revision) VALUES (1, 0)");
    $ensured = true;
}

function bb1CurrentSyncRevision(PDO $pdo): string
{
    bb1EnsureSyncRevisionTable($pdo);
    return (string) $pdo->query("SELECT revision FROM bb1_sync_revision WHERE revision_id = 1")->fetchColumn();
}

function bb1BumpSyncRevision(PDO $pdo): void
{
    bb1EnsureSyncRevisionTable($pdo);
    $pdo->exec("UPDATE bb1_sync_revision SET revision = revision + 1 WHERE revision_id = 1");
}

function bb1LoadResidentRequestChanges(
    PDO $pdo,
    bool $stripEvidence = false,
    ?string $residentCode = null
): array
{
    bb1EnsureResidentRequestChangesTable($pdo);
    $selectColumns = $stripEvidence
        ? "request_id,
            JSON_REMOVE(data_value, '$.requirementPhotos', '$.philsysVerificationEvidence', '$.paymentProof') AS data_value,
            is_deleted,
            JSON_CONTAINS_PATH(data_value, 'one', '$.requirementPhotos', '$.philsysVerificationEvidence', '$.paymentProof') AS has_evidence"
        : "request_id, data_value, is_deleted, 0 AS has_evidence";
    $where = "";
    $parameters = [];
    if ($residentCode !== null) {
        $residentCodeExpression = "COALESCE(
            NULLIF(TRIM(JSON_UNQUOTE(JSON_EXTRACT(data_value, '$.residentCode'))), ''),
            NULLIF(TRIM(JSON_UNQUOTE(JSON_EXTRACT(data_value, '$.resident_code'))), ''),
            NULLIF(TRIM(JSON_UNQUOTE(JSON_EXTRACT(data_value, '$.code'))), ''),
            NULLIF(TRIM(JSON_UNQUOTE(JSON_EXTRACT(data_value, '$.request.residentCode'))), ''),
            NULLIF(TRIM(JSON_UNQUOTE(JSON_EXTRACT(data_value, '$.request.resident_code'))), ''),
            NULLIF(TRIM(JSON_UNQUOTE(JSON_EXTRACT(data_value, '$.request.code'))), ''),
            ''
        )";
        $where = "WHERE is_deleted = 1
            OR $residentCodeExpression = ''
            OR UPPER($residentCodeExpression) = UPPER(?)";
        $parameters[] = $residentCode;
    }

    $statement = $pdo->prepare("
        SELECT $selectColumns
        FROM bb1_resident_request_changes
        $where
        ORDER BY request_id
    ");
    $statement->execute($parameters);
    return $statement->fetchAll(PDO::FETCH_ASSOC);
}

function bb1LoadPriorityResidentRequests(PDO $pdo): array
{
    $countStatement = $pdo->prepare("
        SELECT JSON_TYPE(data_value), JSON_LENGTH(data_value)
        FROM bb1_app_state
        WHERE data_key = ?
        LIMIT 1
    ");
    $countStatement->execute(["bb1-resident-requests"]);
    $countRow = $countStatement->fetch(PDO::FETCH_NUM);
    if (!$countRow) {
        return ["requests" => [], "evidence_ids" => []];
    }
    if ($countRow[0] !== "ARRAY" || !is_numeric($countRow[1])) {
        throw new RuntimeException("Saved resident requests are not a list.");
    }

    $requestCount = (int) $countRow[1];
    $removePaths = [];
    $evidenceFlags = [];
    for ($index = 0; $index < $requestCount; $index++) {
        $requirementPath = '$[' . $index . '].requirementPhotos';
        $philsysPath = '$[' . $index . '].philsysVerificationEvidence';
        $paymentProofPath = '$[' . $index . '].paymentProof';
        $removePaths[] = $pdo->quote($requirementPath);
        $removePaths[] = $pdo->quote($philsysPath);
        $removePaths[] = $pdo->quote($paymentProofPath);
        $evidenceFlags[] = "JSON_CONTAINS_PATH(data_value, 'one', "
            . $pdo->quote($requirementPath) . ", " . $pdo->quote($philsysPath) . ", "
            . $pdo->quote($paymentProofPath) . ")";
    }

    $requestExpression = $removePaths
        ? "JSON_REMOVE(data_value, " . implode(", ", $removePaths) . ")"
        : "data_value";
    $evidenceExpression = $evidenceFlags
        ? "JSON_ARRAY(" . implode(", ", $evidenceFlags) . ")"
        : "JSON_ARRAY()";
    $statement = $pdo->query("
        SELECT $requestExpression AS data_value, $evidenceExpression AS evidence_flags
        FROM bb1_app_state
        WHERE data_key = 'bb1-resident-requests'
        LIMIT 1
    ");
    $row = $statement->fetch(PDO::FETCH_ASSOC);
    if (!$row) {
        return ["requests" => [], "evidence_ids" => []];
    }

    $requests = json_decode((string) $row["data_value"], false, 512, JSON_THROW_ON_ERROR);
    $evidenceFlags = json_decode((string) $row["evidence_flags"], true, 512, JSON_THROW_ON_ERROR);
    if (!is_array($requests) || count($requests) !== $requestCount
        || !is_array($evidenceFlags) || count($evidenceFlags) !== $requestCount) {
        throw new RuntimeException("Saved resident requests could not be summarized.");
    }

    $evidenceIds = [];
    foreach ($requests as $index => $request) {
        if (!($request instanceof stdClass)
            || !is_scalar($request->id ?? null)
            || (string) $request->id === "") {
            throw new RuntimeException("A saved resident request is invalid.");
        }
        if ((int) $evidenceFlags[$index] === 1) {
            $evidenceIds[] = (string) $request->id;
        }
    }

    return ["requests" => $requests, "evidence_ids" => $evidenceIds];
}

function bb1LoadPriorityResidentHistory(PDO $pdo): array
{
    $countStatement = $pdo->prepare("
        SELECT JSON_TYPE(data_value), JSON_LENGTH(data_value)
        FROM bb1_app_state
        WHERE data_key = ?
        LIMIT 1
    ");
    $countStatement->execute(["bb1-resident-history"]);
    $countRow = $countStatement->fetch(PDO::FETCH_NUM);
    if (!$countRow) {
        return ["history" => [], "evidence_ids" => []];
    }
    if ($countRow[0] !== "ARRAY" || !is_numeric($countRow[1])) {
        throw new RuntimeException("Saved resident history is not a list.");
    }

    $historyCount = (int) $countRow[1];
    $removePaths = [];
    $evidenceFlags = [];
    for ($index = 0; $index < $historyCount; $index++) {
        $requirementPath = '$[' . $index . '].request.requirementPhotos';
        $philsysPath = '$[' . $index . '].request.philsysVerificationEvidence';
        $paymentProofPath = '$[' . $index . '].request.paymentProof';
        $removePaths[] = $pdo->quote($requirementPath);
        $removePaths[] = $pdo->quote($philsysPath);
        $removePaths[] = $pdo->quote($paymentProofPath);
        $evidenceFlags[] = "JSON_CONTAINS_PATH(data_value, 'one', "
            . $pdo->quote($requirementPath) . ", " . $pdo->quote($philsysPath) . ", "
            . $pdo->quote($paymentProofPath) . ")";
    }

    $historyExpression = $removePaths
        ? "JSON_REMOVE(data_value, " . implode(", ", $removePaths) . ")"
        : "data_value";
    $evidenceExpression = $evidenceFlags
        ? "JSON_ARRAY(" . implode(", ", $evidenceFlags) . ")"
        : "JSON_ARRAY()";
    $statement = $pdo->query("
        SELECT $historyExpression AS data_value, $evidenceExpression AS evidence_flags
        FROM bb1_app_state
        WHERE data_key = 'bb1-resident-history'
        LIMIT 1
    ");
    $row = $statement->fetch(PDO::FETCH_ASSOC);
    if (!$row) {
        return ["history" => [], "evidence_ids" => []];
    }

    $history = json_decode((string) $row["data_value"], false, 512, JSON_THROW_ON_ERROR);
    $evidenceFlags = json_decode((string) $row["evidence_flags"], true, 512, JSON_THROW_ON_ERROR);
    if (!is_array($history) || count($history) !== $historyCount
        || !is_array($evidenceFlags) || count($evidenceFlags) !== $historyCount) {
        throw new RuntimeException("Saved resident history could not be summarized.");
    }

    $evidenceIds = [];
    foreach ($history as $index => $entry) {
        if ($entry instanceof stdClass
            && ($entry->type ?? null) === "documentRequest"
            && ($entry->request ?? null) instanceof stdClass
            && is_scalar($entry->request->id ?? null)
            && (string) $entry->request->id !== ""
            && empty($entry->request->printCompletedAt)
            && (int) $evidenceFlags[$index] === 1) {
            $evidenceIds[] = (string) $entry->request->id;
        }
    }

    return ["history" => $history, "evidence_ids" => $evidenceIds];
}

function bb1PreserveMissingRequestEvidence(stdClass $request, ?stdClass $previous): stdClass
{
    if (!$previous) {
        return $request;
    }
    $merged = clone $request;
    foreach (["requirementPhotos", "philsysVerificationEvidence", "paymentProof"] as $field) {
        if (!property_exists($merged, $field) && property_exists($previous, $field)) {
            $merged->{$field} = $previous->{$field};
        }
    }
    return $merged;
}

function bb1MergeResidentHistoryEvidence(PDO $pdo, $history): array
{
    if (!is_array($history)) {
        throw new RuntimeException("Saved resident history is not a list.");
    }
    $statement = $pdo->prepare("
        SELECT data_value
        FROM bb1_app_state
        WHERE data_key = ?
        LIMIT 1
    ");
    $statement->execute(["bb1-resident-history"]);
    $savedJson = $statement->fetchColumn();
    $savedHistory = $savedJson === false
        ? []
        : json_decode((string) $savedJson, false, 512, JSON_THROW_ON_ERROR);
    if (!is_array($savedHistory)) {
        throw new RuntimeException("Saved resident history is not a list.");
    }

    $savedRequestsById = [];
    foreach ($savedHistory as $entry) {
        if ($entry instanceof stdClass
            && ($entry->type ?? null) === "documentRequest"
            && ($entry->request ?? null) instanceof stdClass
            && is_scalar($entry->request->id ?? null)) {
            $savedRequestsById[(string) $entry->request->id] = $entry->request;
        }
    }

    $requestsStatement = $pdo->prepare("
        SELECT data_value
        FROM bb1_app_state
        WHERE data_key = ?
        LIMIT 1
    ");
    $requestsStatement->execute(["bb1-resident-requests"]);
    $requestsJson = $requestsStatement->fetchColumn();
    $requests = $requestsJson === false
        ? []
        : json_decode((string) $requestsJson, false, 512, JSON_THROW_ON_ERROR);
    if (!is_array($requests)) {
        throw new RuntimeException("Saved resident requests are not a list.");
    }

    $requestsById = [];
    foreach ($requests as $request) {
        if ($request instanceof stdClass && is_scalar($request->id ?? null)) {
            $requestsById[(string) $request->id] = $request;
        }
    }
    foreach (bb1LoadResidentRequestChanges($pdo) as $change) {
        $requestId = (string) ($change["request_id"] ?? "");
        if ((int) ($change["is_deleted"] ?? 0) === 1) {
            unset($requestsById[$requestId]);
            continue;
        }
        $request = json_decode((string) ($change["data_value"] ?? ""), false, 512, JSON_THROW_ON_ERROR);
        if (!($request instanceof stdClass) || (string) ($request->id ?? "") !== $requestId) {
            throw new RuntimeException("A saved resident request change is invalid.");
        }
        $requestsById[$requestId] = bb1PreserveMissingRequestEvidence(
            $request,
            $requestsById[$requestId] ?? null
        );
    }
    foreach ($requestsById as $requestId => $request) {
        if (isset($savedRequestsById[$requestId])) {
            $savedRequestsById[$requestId] = bb1PreserveMissingRequestEvidence(
                $savedRequestsById[$requestId],
                $request
            );
        } else {
            $savedRequestsById[$requestId] = $request;
        }
    }

    foreach ($history as $entry) {
        if ($entry instanceof stdClass
            && ($entry->type ?? null) === "documentRequest"
            && ($entry->request ?? null) instanceof stdClass
            && is_scalar($entry->request->id ?? null)) {
            $requestId = (string) $entry->request->id;
            $entry->request = bb1PreserveMissingRequestEvidence(
                $entry->request,
                $savedRequestsById[$requestId] ?? null
            );
        }
    }
    return $history;
}

function bb1MergeResidentRequestChanges($baseRequests, array $changes): array
{
    if (!is_array($baseRequests)) {
        throw new RuntimeException("Saved resident requests are not a list.");
    }

    $requestsById = [];
    $requestIds = [];
    foreach ($baseRequests as $request) {
        if (!($request instanceof stdClass) || !isset($request->id)) {
            throw new RuntimeException("A saved resident request is invalid.");
        }
        $requestId = (string) $request->id;
        if (!array_key_exists($requestId, $requestsById)) {
            $requestIds[] = $requestId;
        }
        $requestsById[$requestId] = $request;
    }

    foreach ($changes as $change) {
        $requestId = (string) ($change["request_id"] ?? "");
        if ($requestId === "") {
            throw new RuntimeException("A saved resident request change is invalid.");
        }
        if ((int) ($change["is_deleted"] ?? 0) === 1) {
            unset($requestsById[$requestId]);
            continue;
        }

        $request = json_decode((string) ($change["data_value"] ?? ""), false, 512, JSON_THROW_ON_ERROR);
        if (!($request instanceof stdClass)
            || !isset($request->id)
            || (string) $request->id !== $requestId) {
            throw new RuntimeException("A saved resident request change is invalid.");
        }
        if (!array_key_exists($requestId, $requestsById)) {
            $requestIds[] = $requestId;
        }
        $requestsById[$requestId] = $request;
    }

    return array_values(array_map(
        static fn(string $requestId) => $requestsById[$requestId],
        array_values(array_filter($requestIds, static fn(string $requestId) => array_key_exists($requestId, $requestsById)))
    ));
}

function bb1SaveResidentRequestChanges(PDO $pdo, array $upserts, array $deletedIds): void
{
    bb1EnsureResidentRequestChangesTable($pdo);
    $statement = $pdo->prepare("
        INSERT INTO bb1_resident_request_changes (request_id, data_value, is_deleted)
        VALUES (?, ?, ?)
        ON DUPLICATE KEY UPDATE
            data_value = VALUES(data_value),
            is_deleted = VALUES(is_deleted)
    ");

    foreach ($upserts as $request) {
        $requestId = (string) $request->id;
        $encodedRequest = json_encode(
            $request,
            JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_THROW_ON_ERROR
        );
        $statement->execute([$requestId, $encodedRequest, 0]);
    }

    foreach ($deletedIds as $requestId) {
        $statement->execute([$requestId, null, 1]);
    }
}

function bb1ClearResidentRequestChanges(PDO $pdo): void
{
    bb1EnsureResidentRequestChangesTable($pdo);
    $pdo->exec("DELETE FROM bb1_resident_request_changes");
}
