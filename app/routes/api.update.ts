import { json } from '@remix-run/node';
import type { ActionFunction } from '@remix-run/node';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

interface UpdateRequestBody {
  branch: string;
}

interface UpdateProgress {
  stage: 'fetch' | 'pull' | 'install' | 'build' | 'complete';
  message: string;
  progress?: number;
  error?: string;
  details?: {
    changedFiles?: string[];
    additions?: number;
    deletions?: number;
    commitMessages?: string[];
    totalSize?: string;
    currentCommit?: string;
    remoteCommit?: string;
  };
}

export const action: ActionFunction = async ({ request }) => {
  if (request.method !== 'POST') {
    return json({ error: 'Method not allowed' }, { status: 405 });
  }

  try {
    const body = await request.json();

    if (!body || typeof body !== 'object' || !('branch' in body) || typeof body.branch !== 'string') {
      return json({ error: 'Invalid request body: branch is required and must be a string' }, { status: 400 });
    }

    const { branch } = body as UpdateRequestBody;

    // Create a ReadableStream to send progress updates
    const stream = new ReadableStream({
      async start(controller) {
        const encoder = new TextEncoder();
        const sendProgress = (update: UpdateProgress) => {
          controller.enqueue(encoder.encode(JSON.stringify(update) + '\n'));
        };

        try {
          // Check if remote exists
          let defaultBranch = branch || 'main'; // Make branch mutable

          try {
            await execAsync('git remote get-url origin');
          } catch {
            throw new Error(
              'No remote repository found. Please set up the remote repository first by running:\ngit remote add origin https://github.com/stackblitz-labs/bolt.diy.git',
            );
          }

          // Get default branch if not specified
          if (!branch) {
            try {
              const { stdout } = await execAsync('git remote show origin | grep "HEAD branch" | cut -d" " -f5');
              defaultBranch = stdout.trim() || 'main';
            } catch {
              defaultBranch = 'main'; // Fallback to main if we can't detect
            }
          }

          // Fetch stage
          sendProgress({
            stage: 'fetch',
            message: 'Fetching latest changes...',
            progress: 0,
          });

          // Fetch all remotes
          await execAsync('git fetch --all');

          // Check if remote branch exists
          try {
            await execAsync(`git rev-parse --verify origin/${defaultBranch}`);
          } catch {
            throw new Error(`Remote branch 'origin/${defaultBranch}' not found. Please push your changes first.`);
          }

          // Get current commit hash and remote commit hash
          const { stdout: currentCommit } = await execAsync('git rev-parse HEAD');
          const { stdout: remoteCommit } = await execAsync(`git rev-parse origin/${defaultBranch}`);

          // If we're on the same commit, no update is available
          if (currentCommit.trim() === remoteCommit.trim()) {
            sendProgress({
              stage: 'complete',
              message: 'No updates available. You are on the latest version.',
              progress: 100,
            });
            return;
          }

          // Initialize variables
          let changedFiles: string[] = [];
          let commitMessages: string[] = [];
          let stats: RegExpMatchArray | null = null;
          let totalSizeInBytes = 0;

          // Format size for display
          const formatSize = (bytes: number) => {
            if (bytes === 0) {
              return '0 B';
            }

            const k = 1024;
            const sizes = ['B', 'KB', 'MB', 'GB'];
            const i = Math.floor(Math.log(bytes) / Math.log(k));

            return `${parseFloat((bytes / Math.pow(k, i)).toFixed(2))} ${sizes[i]}`;
          };

          // Get list of changed files and their sizes
          try {
            const { stdout: diffOutput } = await execAsync(
              `git diff --name-status ${currentCommit.trim()}..${remoteCommit.trim()}`,
            );
            const files = diffOutput.split('\n').filter(Boolean);

            if (files.length === 0) {
              sendProgress({
                stage: 'complete',
                message: `No file changes detected between your version and origin/${defaultBranch}. You might be on a different branch.`,
                progress: 100,
              });
              return;
            }

            // Get size information for each changed file
            for (const line of files) {
              const [status, file] = line.split('\t');

              if (status !== 'D') {
                // Skip deleted files
                try {
                  const { stdout: sizeOutput } = await execAsync(`git cat-file -s ${remoteCommit.trim()}:${file}`);
                  const size = parseInt(sizeOutput) || 0;
                  totalSizeInBytes += size;
                } catch {
                  console.debug(`Could not get size for file: ${file}`);
                }
              }
            }

            changedFiles = files.map((line) => {
              const [status, file] = line.split('\t');
              return `${status === 'M' ? 'Modified' : status === 'A' ? 'Added' : 'Deleted'}: ${file}`;
            });
          } catch (err) {
            console.debug('Failed to get changed files:', err);
            throw new Error(`Failed to compare changes with origin/${defaultBranch}. Are you on the correct branch?`);
          }

          // Get commit messages between current and remote
          try {
            const { stdout: logOutput } = await execAsync(
              `git log --oneline ${currentCommit.trim()}..${remoteCommit.trim()}`,
            );
            commitMessages = logOutput.split('\n').filter(Boolean);
          } catch {
            // Handle silently - empty commitMessages array will be used
          }

          // Get diff stats using the specific commits
          try {
            const { stdout: diffStats } = await execAsync(
              `git diff --shortstat ${currentCommit.trim()}..${remoteCommit.trim()}`,
            );
            stats = diffStats.match(
              /(\d+) files? changed(?:, (\d+) insertions?\\(\\+\\))?(?:, (\d+) deletions?\\(-\\))?/,
            );
          } catch {
            // Handle silently - null stats will be used
          }

          // If we somehow still have no changes detected
          if (!stats && changedFiles.length === 0) {
            sendProgress({
              stage: 'complete',
              message: `No changes detected between your version and origin/${defaultBranch}. This might be unexpected - please check your git status.`,
              progress: 100,
            });
            return;
          }

          // We have changes, send the details
          sendProgress({
            stage: 'fetch',
            message: `Changes detected on origin/${defaultBranch}`,
            progress: 100,
            details: {
              changedFiles,
              additions: stats?.[2] ? parseInt(stats[2]) : 0,
              deletions: stats?.[3] ? parseInt(stats[3]) : 0,
              commitMessages,
              totalSize: formatSize(totalSizeInBytes),
              currentCommit: currentCommit.trim().substring(0, 7),
              remoteCommit: remoteCommit.trim().substring(0, 7),
            },
          });

          // Pull stage
          sendProgress({
            stage: 'pull',
            message: `Pulling changes from ${defaultBranch}...`,
            progress: 0,
          });

          await execAsync(`git pull origin ${defaultBranch}`);

          sendProgress({
            stage: 'pull',
            message: 'Changes pulled successfully',
            progress: 100,
          });

          // Install stage
          sendProgress({
            stage: 'install',
            message: 'Installing dependencies...',
            progress: 0,
          });

          await execAsync('pnpm install');

          sendProgress({
            stage: 'install',
            message: 'Dependencies installed successfully',
            progress: 100,
          });

          // Build stage
          sendProgress({
            stage: 'build',
            message: 'Building application...',
            progress: 0,
          });

          await execAsync('pnpm build');

          sendProgress({
            stage: 'build',
            message: 'Build completed successfully',
            progress: 100,
          });

          // Complete
          sendProgress({
            stage: 'complete',
            message: 'Update completed successfully! Click Restart to apply changes.',
            progress: 100,
          });
        } catch (err) {
          sendProgress({
            stage: 'complete',
            message: 'Update failed',
            error: err instanceof Error ? err.message : 'Unknown error occurred',
          });
        } finally {
          controller.close();
        }
      },
    });

    return new Response(stream, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      },
    });
  } catch (err) {
    console.error('Update preparation failed:', err);
    return json(
      {
        success: false,
        error: err instanceof Error ? err.message : 'Unknown error occurred while preparing update',
      },
      { status: 500 },
    );
  }
};
