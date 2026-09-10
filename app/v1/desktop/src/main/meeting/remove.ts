import { existsSync } from 'node:fs'
import path from 'node:path'

/**
 * Take a removed meeting's recording off disk: into the Recycle Bin, not gone.
 *
 * WHY REMOVING HAS TO TOUCH THE DISK AT ALL. Removing a meeting used to delete
 * the row and leave the directory, on the reasoning that deleting a recording
 * of other people is a separate decision from tidying a list. But the directory
 * is what startup reconciles against - every recording on disk gets a row - so
 * every meeting you removed came back at the next launch, and nothing in the
 * app could make one stay gone.
 *
 * THE BIN, NOT A DELETE. It is where Windows keeps what somebody removed and
 * might want back, it is emptied on their terms, and it takes the directory out
 * of reconciliation's sight. A marker file would have fixed the list too, and
 * left an hour of other people's voices somewhere nobody would ever look.
 *
 * Only ever a direct child of the meetings directory. A stored path is data,
 * and one that pointed anywhere else must not become a way to bin it.
 *
 * @returns why it could not, or null once the recording is out of the way.
 */
export async function discardRecording(
  root: string,
  dir: string,
  trash: (target: string) => Promise<void>
): Promise<string | null> {
  const relative = path.relative(root, dir)
  if (
    !relative ||
    relative.startsWith('..') ||
    path.isAbsolute(relative) ||
    relative.includes(path.sep)
  ) {
    return `${dir} is not a meeting recording, so it was left alone.`
  }
  if (!existsSync(dir)) return null

  try {
    await trash(dir)
    return null
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    return `The recording could not be moved to the Recycle Bin (${reason}). Close anything that has it open and try again.`
  }
}
