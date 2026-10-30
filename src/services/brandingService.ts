import { Chalk, supportsColor } from 'chalk';

// Sampled from the existing Tityra bird SVG in assets/tityra-mark.svg.
// Unicode cells preserve the silhouette without requiring a terminal image protocol.
const bird = [
  '⡀       ⣦⡀          ',
  '⠘⣷⣤⣀    ⣿⣷⣄         ',
  ' ⠹⣿⣿⣷⣦⣀ ⠙⢿⣿⣷⡄       ',
  '  ⢠⣙⡻⢿⣿⣿⣦⣄⠈⠻⢿⠂ ⣠⣤⣤⣀ ',
  '   ⢿⣿⣿⣿⣿⣿⣿⣿⣶⣄⡐⣿⣿⡿⠛⠉⠉',
  '   ⠈⠉⠛⠛⠿⢿⣿⣿⣿⣿⡿⠞⠁    ',
  '       ⢀⣾⣿⣿⠟⠉       ',
  '      ⢠⣾⠿⠋          ',
  '     ⡠⠋⠁            ',
];

/** Keep branding in interactive help/workspaces, never in machine-readable output. */
export function welcomeBanner(version: string, color = true): string {
  if (!process.stdout.isTTY || process.argv.includes('--json')) return '';
  const paint = new Chalk({
    level: color && !('NO_COLOR' in process.env) && supportsColor ? supportsColor.level : 0,
  });
  if (process.env.TERM === 'dumb') return `\nTityra · v${version}\n`;
  const captions: Record<number, string> = {
    2: paint.hex('#ed4832').bold('Tityra'),
    4: (process.stdout.columns || 80) >= 70 ? 'Your workspace, from the terminal.' : '',
    5: paint.dim(`v${version}`),
  };
  return (
    '\n' +
    bird.map((line, index) => `  ${line}   ${captions[index] || ''}`.trimEnd()).join('\n') +
    '\n'
  );
}
