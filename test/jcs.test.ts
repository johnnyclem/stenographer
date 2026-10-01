import { describe, it, expect } from 'vitest';
import { canonicalize, sha256Hex, CanonicalizationError } from '../src/truth/jcs.js';

/** An IEEE 754 double from its 16-hex-digit bit pattern (RFC 8785 Appendix B). */
function double(hex: string): number {
  const view = new DataView(new ArrayBuffer(8));
  view.setBigUint64(0, BigInt(`0x${hex}`));
  return view.getFloat64(0);
}

describe('JCS (RFC 8785)', () => {
  it('matches the RFC 8785 §3.2.4 example', () => {
    const input = JSON.parse(
      '{"numbers": [333333333.33333329, 1E30, 4.50, 2e-3, 0.000000000000000000000000001],' +
        ' "string": "\\u20ac$\\u000F\\u000aA\'\\u0042\\u0022\\u005c\\\\\\"\\/",' +
        ' "literals": [null, true, false]}'
    );
    expect(canonicalize(input)).toBe(
      '{"literals":[null,true,false],"numbers":[333333333.3333333,1e+30,4.5,0.002,1e-27],' +
        '"string":"€$\\u000f\\nA\'B\\"\\\\\\\\\\"/"}'
    );
  });

  it('sorts keys by UTF-16 code units, not code points (RFC 8785 §3.2.3)', () => {
    const input = {
      '€': 'Euro Sign',
      '\r': 'Carriage Return',
      'דּ': 'Hebrew Letter Dalet With Dagesh',
      '1': 'One',
      '😀': 'Emoji: Grinning Face',
      '\u0080': 'Control',
      'ö': 'Latin Small Letter O With Diaeresis',
    };
    // U+1F600 is the surrogate pair D83D DE00, which sorts before U+FB33
    expect(canonicalize(input)).toBe(
      '{"\\r":"Carriage Return","1":"One","\u0080":"Control","ö":"Latin Small Letter O With Diaeresis",' +
        '"€":"Euro Sign","😀":"Emoji: Grinning Face","דּ":"Hebrew Letter Dalet With Dagesh"}'
    );
    expect(canonicalize({ b: 1, a: { d: [], c: {} } })).toBe('{"a":{"c":{},"d":[]},"b":1}');
  });

  it('formats numbers as ECMAScript does (RFC 8785 Appendix B)', () => {
    const vectors: Array<[string, string]> = [
      ['0000000000000000', '0'],
      ['8000000000000000', '0'],
      ['0000000000000001', '5e-324'],
      ['8000000000000001', '-5e-324'],
      ['7fefffffffffffff', '1.7976931348623157e+308'],
      ['ffefffffffffffff', '-1.7976931348623157e+308'],
      ['4340000000000000', '9007199254740992'],
      ['c340000000000000', '-9007199254740992'],
      ['4430000000000000', '295147905179352830000'],
      ['44b52d02c7e14af5', '9.999999999999997e+22'],
      ['44b52d02c7e14af6', '1e+23'],
      ['44b52d02c7e14af7', '1.0000000000000001e+23'],
      ['444b1ae4d6e2ef4e', '999999999999999700000'],
      ['444b1ae4d6e2ef4f', '999999999999999900000'],
      ['444b1ae4d6e2ef50', '1e+21'],
      ['3eb0c6f7a0b5ed8c', '9.999999999999997e-7'],
      ['3eb0c6f7a0b5ed8d', '0.000001'],
      ['41b3de4355555553', '333333333.3333332'],
      ['41b3de4355555554', '333333333.33333325'],
      ['41b3de4355555555', '333333333.3333333'],
      ['41b3de4355555556', '333333333.3333334'],
      ['41b3de4355555557', '333333333.33333343'],
      ['becbf647612f3696', '-0.0000033333333333333333'],
      ['43143ff3c1cb0959', '1424953923781206.2'],
    ];
    for (const [bits, expected] of vectors) {
      expect(canonicalize(double(bits)), bits).toBe(expected);
    }
  });

  it('rejects values JSON cannot represent instead of coercing them', () => {
    for (const bad of [NaN, Infinity, -Infinity, double('7fffffffffffffff'), double('7ff0000000000000')]) {
      expect(() => canonicalize({ n: bad })).toThrow(CanonicalizationError);
    }
    expect(() => canonicalize([undefined])).toThrow(CanonicalizationError);
    expect(() => canonicalize(10n)).toThrow(CanonicalizationError);
    expect(() => canonicalize({ d: new Date(0) })).toThrow(CanonicalizationError);
    expect(() => canonicalize('\ud800')).toThrow(/lone surrogate/);
    expect(() => canonicalize({ ['a\udc00']: 1 })).toThrow(/lone surrogate/);
    // Undefined members are absent, as in JSON
    expect(canonicalize({ a: undefined, b: null })).toBe('{"b":null}');
  });

  it('escapes only what JSON requires', () => {
    expect(canonicalize('\u0000\u001f\u007f "\\/é')).toBe('"\\u0000\\u001f\u007f \\"\\\\/é"');
    expect(canonicalize('\b\t\n\f\r')).toBe('"\\b\\t\\n\\f\\r"');
  });

  it('hashes UTF-8 bytes as lowercase hex SHA-256', () => {
    expect(sha256Hex('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    expect(sha256Hex(canonicalize({ b: 2, a: 'é' }))).toBe(sha256Hex('{"a":"é","b":2}'));
  });
});
