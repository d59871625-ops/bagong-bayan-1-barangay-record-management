<?php
declare(strict_types=1);

require_once __DIR__ . '/config.php';
try {
    loadBackendEnvironment(__DIR__ . '/.env');
} catch (RuntimeException $error) {
    error_log('Certificate PDF configuration error: ' . $error->getMessage());
    http_response_code(500);
    exit('The certificate PDF converter is not configured correctly.');
}

$allowedOrigins = [
    'https://airi.infinityfreeapp.com',
    'http://localhost:5173',
    'http://127.0.0.1:5173',
    'http://localhost:4173',
    'http://127.0.0.1:4173',
];
$configuredOrigin = backendEnv('CERTIFICATE_PDF_ALLOWED_ORIGIN');
if ($configuredOrigin !== false && $configuredOrigin !== '') {
    $allowedOrigins = array_filter(array_map('trim', explode(',', $configuredOrigin)));
}

$origin = $_SERVER['HTTP_ORIGIN'] ?? '';
if ($origin !== '') {
    if (!in_array($origin, $allowedOrigins, true)) {
        http_response_code(403);
        exit('Origin is not allowed.');
    }

    header("Access-Control-Allow-Origin: $origin");
    header('Vary: Origin');
}

header('Access-Control-Allow-Methods: POST, OPTIONS');
header('Access-Control-Allow-Headers: Content-Type, Authorization');
header('Cache-Control: no-store, no-cache, must-revalidate, max-age=0');
header('Pragma: no-cache');
header('Expires: 0');

if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') {
    http_response_code(204);
    exit;
}

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    http_response_code(405);
    header('Allow: POST, OPTIONS');
    exit('Use POST to convert a filled certificate.');
}

require_once __DIR__ . '/db.php';
require_once __DIR__ . '/auth.php';
authenticateUser($pdo, ['admin', 'official']);

$workingDirectory = '';

$removeDirectory = static function (string $directory) use (&$removeDirectory): void {
    if (!is_dir($directory) || is_link($directory)) {
        return;
    }

    foreach (new FilesystemIterator($directory, FilesystemIterator::SKIP_DOTS) as $entry) {
        if ($entry->isDir() && !$entry->isLink()) {
            $removeDirectory($entry->getPathname());
        } else {
            @unlink($entry->getPathname());
        }
    }

    @rmdir($directory);
};

$resolveExecutable = static function (array $candidates): ?string {
    $extensions = PHP_OS_FAMILY === 'Windows' ? ['', '.com', '.exe'] : [''];
    $pathDirectories = array_filter(explode(PATH_SEPARATOR, (string) backendEnv('PATH')));

    foreach ($candidates as $candidate) {
        if (!is_string($candidate) || $candidate === '') {
            continue;
        }

        $paths = [];
        if (is_dir($candidate)) {
            foreach ($extensions as $extension) {
                $paths[] = rtrim($candidate, '\\/') . DIRECTORY_SEPARATOR . 'soffice' . $extension;
                $paths[] = rtrim($candidate, '\\/') . DIRECTORY_SEPARATOR . 'program' . DIRECTORY_SEPARATOR . 'soffice' . $extension;
            }
        } elseif (strpbrk($candidate, '\\/') !== false) {
            $paths[] = $candidate;
        } else {
            foreach ($extensions as $extension) {
                $name = str_ends_with(strtolower($candidate), strtolower($extension)) && $extension !== ''
                    ? $candidate
                    : $candidate . $extension;
                foreach ($pathDirectories as $pathDirectory) {
                    $paths[] = rtrim($pathDirectory, '\\/') . DIRECTORY_SEPARATOR . $name;
                }
            }
        }

        foreach ($paths as $path) {
            if (is_file($path)) {
                return realpath($path) ?: $path;
            }
        }
    }

    return null;
};

$runCommand = static function (array $command): array {
    $descriptors = [
        0 => ['pipe', 'r'],
        1 => ['pipe', 'w'],
        2 => ['pipe', 'w'],
    ];
    error_clear_last();
    $process = @proc_open(
        $command,
        $descriptors,
        $pipes,
        null,
        null,
        PHP_OS_FAMILY === 'Windows' ? ['bypass_shell' => true] : []
    );
    if (!is_resource($process)) {
        $warning = error_get_last();
        if ($warning !== null) {
            error_log('Unable to start certificate converter process: ' . $warning['message']);
        }
        throw new RuntimeException('Unable to start the certificate PDF converter. Check the configured converter path and PHP permissions.');
    }

    fclose($pipes[0]);
    $stdout = stream_get_contents($pipes[1]);
    fclose($pipes[1]);
    $stderr = stream_get_contents($pipes[2]);
    fclose($pipes[2]);

    return [
        'exitCode' => proc_close($process),
        'stdout' => $stdout,
        'stderr' => $stderr,
    ];
};

try {
    if (!function_exists('proc_open')) {
        throw new RuntimeException('PHP proc_open must be enabled to convert certificate files.');
    }
    if (!isset($_FILES['certificate']) || $_FILES['certificate']['error'] !== UPLOAD_ERR_OK) {
        throw new RuntimeException('A filled DOCX certificate is required.');
    }

    $upload = $_FILES['certificate'];
    if (!is_uploaded_file($upload['tmp_name']) || $upload['size'] <= 0 || $upload['size'] > 15 * 1024 * 1024) {
        throw new RuntimeException('The DOCX file is invalid or exceeds the 15 MB limit.');
    }

    $fileHeader = file_get_contents($upload['tmp_name'], false, null, 0, 4);
    if ($fileHeader !== "PK\x03\x04") {
        throw new RuntimeException('The uploaded certificate is not a valid DOCX file.');
    }

    $configuredBinary = backendEnv('LIBREOFFICE_PATH');
    $officeBinary = $resolveExecutable(array_filter([
        $configuredBinary !== false && $configuredBinary !== '' ? $configuredBinary : null,
        'soffice',
        'C:\\Program Files\\LibreOffice\\program\\soffice.com',
        'C:\\Program Files\\LibreOffice\\program\\soffice.exe',
        'C:\\Program Files (x86)\\LibreOffice\\program\\soffice.com',
        'C:\\Program Files (x86)\\LibreOffice\\program\\soffice.exe',
    ]));

    $workingDirectory = rtrim(sys_get_temp_dir(), DIRECTORY_SEPARATOR)
        . DIRECTORY_SEPARATOR . 'certificate-pdf-' . bin2hex(random_bytes(16));
    if (!mkdir($workingDirectory, 0700)) {
        throw new RuntimeException('Unable to prepare a temporary PDF conversion directory.');
    }

    $inputPath = $workingDirectory . DIRECTORY_SEPARATOR . 'certificate.docx';
    $profileDirectory = $workingDirectory . DIRECTORY_SEPARATOR . 'office-profile';
    if (!mkdir($profileDirectory, 0700) || !move_uploaded_file($upload['tmp_name'], $inputPath)) {
        throw new RuntimeException('Unable to prepare the DOCX file for conversion.');
    }

    $pdfPath = $workingDirectory . DIRECTORY_SEPARATOR . 'certificate.pdf';
    if ($officeBinary !== null) {
        $profileUrl = 'file://' . str_replace('\\', '/', $profileDirectory);
        $result = $runCommand([
            $officeBinary,
            '-env:UserInstallation=' . $profileUrl,
            '--headless',
            '--convert-to',
            'pdf:writer_pdf_Export',
            '--outdir',
            $workingDirectory,
            $inputPath,
        ]);
        if ($result['exitCode'] !== 0 || !is_file($pdfPath) || filesize($pdfPath) < 5) {
            error_log('LibreOffice certificate conversion failed: ' . trim($result['stderr'] . ' ' . $result['stdout']));
            throw new RuntimeException('LibreOffice could not convert this certificate to PDF.');
        }
    } elseif (PHP_OS_FAMILY === 'Windows') {
        $programFiles = backendEnv('ProgramFiles') ?: 'C:\\Program Files';
        $programFilesX86 = backendEnv('ProgramFiles(x86)') ?: 'C:\\Program Files (x86)';
        $wordBinary = $resolveExecutable(array_filter([
            backendEnv('MICROSOFT_WORD_PATH') ?: null,
            $programFiles . '\\Microsoft Office\\root\\Office16\\WINWORD.EXE',
            $programFilesX86 . '\\Microsoft Office\\root\\Office16\\WINWORD.EXE',
            'winword.exe',
        ]));
        $powerShellBinary = $resolveExecutable([
            (backendEnv('SystemRoot') ?: 'C:\\Windows') . '\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
            'powershell.exe',
        ]);
        if ($wordBinary === null || $powerShellBinary === null) {
            throw new RuntimeException('LibreOffice or Microsoft Word was not found. Install a document converter or configure LIBREOFFICE_PATH or MICROSOFT_WORD_PATH.');
        }
        if (!function_exists('iconv')) {
            throw new RuntimeException('The iconv PHP extension is required for Microsoft Word PDF conversion.');
        }

        $inputLiteral = "'" . str_replace("'", "''", $inputPath) . "'";
        $pdfLiteral = "'" . str_replace("'", "''", $pdfPath) . "'";
        $wordScript = implode("\n", [
            '$ErrorActionPreference = "Stop"',
            '$word = $null',
            '$document = $null',
            '$cleanupWarnings = @()',
            'try {',
            '  $word = New-Object -ComObject Word.Application',
            '  $word.Visible = $false',
            '  $word.DisplayAlerts = 0',
            '  $document = $word.Documents.Open(' . $inputLiteral . ', $false, $true)',
            '  $document.ExportAsFixedFormat(' . $pdfLiteral . ', 17)',
            '} finally {',
            '  if ($document) { try { $document.Close(0) } catch { $cleanupWarnings += $_.Exception.Message } }',
            '  if ($word) { try { $word.Quit(0) } catch { $cleanupWarnings += $_.Exception.Message }; try { [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($word) } catch { $cleanupWarnings += $_.Exception.Message } }',
            '  if ($cleanupWarnings.Count -gt 0) { [Console]::Error.WriteLine(($cleanupWarnings -join "; ")) }',
            '}',
        ]);
        $encodedCommand = base64_encode(iconv('UTF-8', 'UTF-16LE', $wordScript));
        $result = $runCommand([
            $powerShellBinary,
            '-NoLogo',
            '-NoProfile',
            '-NonInteractive',
            '-ExecutionPolicy',
            'Bypass',
            '-EncodedCommand',
            $encodedCommand,
        ]);
        if ($result['exitCode'] !== 0 || !is_file($pdfPath) || filesize($pdfPath) < 5) {
            error_log('Microsoft Word certificate conversion failed: ' . trim($result['stderr'] . ' ' . $result['stdout']));
            throw new RuntimeException('Microsoft Word could not convert this certificate to PDF.');
        }
    } else {
        throw new RuntimeException('LibreOffice was not found. Install it or configure LIBREOFFICE_PATH.');
    }

    $pdfHeader = file_get_contents($pdfPath, false, null, 0, 5);
    if ($pdfHeader !== '%PDF-') {
        throw new RuntimeException('The conversion result is not a valid PDF file.');
    }

    header('Content-Type: application/pdf');
    header('Content-Disposition: attachment; filename="certificate.pdf"');
    header('Content-Length: ' . filesize($pdfPath));
    readfile($pdfPath);
} catch (Throwable $error) {
    http_response_code(500);
    header('Content-Type: text/plain; charset=utf-8');
    error_log('Certificate PDF endpoint error: ' . $error->getMessage());
    echo $error->getMessage();
} finally {
    if ($workingDirectory !== '') {
        $removeDirectory($workingDirectory);
    }
}
