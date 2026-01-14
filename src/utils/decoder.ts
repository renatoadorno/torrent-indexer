export function reverseString(s: string): string {
  return s.split('').reverse().join('');
}

export function decodeAdLink(encodedStr: string): string {
  if (!encodedStr) {
    throw new Error("empty string");
  }
  const reversed = reverseString(encodedStr);
  const decoded = atob(reversed);
  return unescapeHTML(decoded);
}

function unescapeHTML(str: string): string {
    const map: Record<string, string> = {
        '&amp;': '&',
        '&lt;': '<',
        '&gt;': '>',
        '&quot;': '"',
        '&#039;': "'"
    };
    return str.replace(/&amp;|&lt;|&gt;|&quot;|&#039;/g, (m) => map[m] || m);
}

export function unshuffleString(shuffled: string): string {
  const length = shuffled.length;
  const original = new Array(length);
  const used = new Array(length).fill(false);
  let index = 0;
  const step = 3;

  const shuffledRunes = shuffled.split('');

  for (let i = 0; i < length; i++) {
    while (used[index]) {
      index = (index + 1) % length;
    }

    used[index] = true;
    original[i] = shuffledRunes[index];
    index = (index + step) % length;
  }

  return original.join('');
}
