<?php

function loadBackendEnvironment(string $path): void
{
    if (!is_file($path)) {
        return;
    }

    $lines = file($path, FILE_IGNORE_NEW_LINES);
    if ($lines === false) {
        throw new RuntimeException("Unable to read the backend environment file.");
    }

    foreach ($lines as $lineNumber => $line) {
        $line = trim($line);
        if ($line === "" || str_starts_with($line, "#")) {
            continue;
        }

        $separator = strpos($line, "=");
        if ($separator === false) {
            throw new RuntimeException("Invalid backend environment entry on line " . ($lineNumber + 1) . ".");
        }

        $name = trim(substr($line, 0, $separator));
        $value = trim(substr($line, $separator + 1));
        if (!preg_match('/^[A-Z_][A-Z0-9_]*$/', $name)) {
            throw new RuntimeException("Invalid backend environment variable name on line " . ($lineNumber + 1) . ".");
        }

        if ($value !== "" && ($value[0] === '"' || $value[0] === "'")) {
            $quote = $value[0];
            if (strlen($value) < 2 || substr($value, -1) !== $quote) {
                throw new RuntimeException("Unclosed backend environment value on line " . ($lineNumber + 1) . ".");
            }
            $value = substr($value, 1, -1);
        }

        $currentValue = getenv($name);
        if ($currentValue === false || $currentValue === "") {
            putenv($name . "=" . $value);
        }
    }
}
