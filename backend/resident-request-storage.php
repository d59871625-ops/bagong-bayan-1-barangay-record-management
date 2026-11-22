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

function bb1LoadResidentRequestChanges(PDO $pdo, bool $stripEvidence = false): array
{
    bb1EnsureResidentRequestChangesTable($pdo);
    $selectColumns = $stripEvidence
        ? "request_id,
            JSON_REMOVE(data_value, '$.requirementPhotos', '$.philsysVerificationEvidence') AS data_value,
            is_deleted,
            JSON_CONTAINS_PATH(data_value, 'one', '$.requirementPhotos', '$.philsysVerificationEvidence') AS has_evidence"
        : "request_id, data_value, is_deleted, 0 AS has_evidence";
    $statement = $pdo->query("
        SELECT $selectColumns
        FROM bb1_resident_request_changes
        ORDER BY request_id
    ");
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
        $removePaths[] = $pdo->quote($requirementPath);
        $removePaths[] = $pdo->quote($philsysPath);
        $evidenceFlags[] = "JSON_CONTAINS_PATH(data_value, 'one', "
            . $pdo->quote($requirementPath) . ", " . $pdo->quote($philsysPath) . ")";
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
