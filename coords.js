// Parses a pair of hand-typed geographic coordinates into { lat, lon } in degrees.
// Accepts decimal degrees, degrees/minutes/seconds, hemisphere letters before or after
// the number, and a comma, semicolon or whitespace between the two values. Returns null
// for anything that is not exactly two valid coordinates (town names, one number, more
// than two values, minutes or seconds of 60 and above).
(function () {
  "use strict";

  const NUMBER_PATTERN = /^[-+]?(?:\d+(?:\.\d*)?|\.\d+)$/;
  const TOKEN_PATTERN = /[-+]?(?:\d+(?:\.\d*)?|\.\d+)|[°º]|['′]|["″]|[NSEWnsew]/y;

  // Splits the text into numbers, degree/minute/second marks and hemisphere letters.
  // Whitespace, commas and semicolons are separators; any other character is a rejection.
  function tokenize(text) {
    const tokens = [];
    let index = 0;
    while (index < text.length) {
      const character = text[index];
      if (/\s/.test(character) || character === "," || character === ";") { index++; continue; }
      TOKEN_PATTERN.lastIndex = index;
      const match = TOKEN_PATTERN.exec(text);
      if (!match) return null;
      index = TOKEN_PATTERN.lastIndex;
      const value = match[0];
      if (NUMBER_PATTERN.test(value)) tokens.push({ type: "number", value: Number(value) });
      else if (value === "°" || value === "º") tokens.push({ type: "degree" });
      else if (value === "'" || value === "′") tokens.push({ type: "minute" });
      else if (value === '"' || value === "″") tokens.push({ type: "second" });
      else tokens.push({ type: "hemisphere", value: value.toUpperCase() });
    }
    return tokens;
  }

  // Reads one coordinate starting at tokens[start]. Minutes and seconds are only taken
  // when their marks follow a degree value, so two bare numbers stay two coordinates.
  function parseCoordinate(tokens, start) {
    let index = start;
    let hemisphere = null;
    if (tokens[index] && tokens[index].type === "hemisphere") {
      hemisphere = tokens[index].value;
      index++;
    }
    const degreeToken = tokens[index];
    if (!degreeToken || degreeToken.type !== "number") return null;
    const degrees = degreeToken.value;
    index++;
    let minutes = 0, seconds = 0;
    if (tokens[index] && tokens[index].type === "degree") {
      index++;
      if (tokens[index] && tokens[index].type === "number"
        && tokens[index + 1] && tokens[index + 1].type === "minute") {
        minutes = tokens[index].value;
        index += 2;
        if (tokens[index] && tokens[index].type === "number"
          && tokens[index + 1] && tokens[index + 1].type === "second") {
          seconds = tokens[index].value;
          index += 2;
        }
      }
    }
    // A hemisphere before the number makes a following letter the next coordinate's prefix.
    if (!hemisphere && tokens[index] && tokens[index].type === "hemisphere") {
      hemisphere = tokens[index].value;
      index++;
    }
    return { degrees, minutes, seconds, hemisphere, index };
  }

  function coordinateValue(part) {
    if (part.minutes < 0 || part.minutes >= 60) return null;
    if (part.seconds < 0 || part.seconds >= 60) return null;
    const hemisphere = part.hemisphere;
    const sign = hemisphere === "S" || hemisphere === "W" ? -1
      : hemisphere === "N" || hemisphere === "E" ? 1
        : part.degrees < 0 ? -1 : 1;
    return sign * (Math.abs(part.degrees) + part.minutes / 60 + part.seconds / 3600);
  }

  function axisOf(hemisphere) {
    if (hemisphere === "N" || hemisphere === "S") return "lat";
    if (hemisphere === "E" || hemisphere === "W") return "lon";
    return null;
  }

  function parseCoordinates(text) {
    if (typeof text !== "string" || !text.trim()) return null;
    const tokens = tokenize(text.trim());
    if (!tokens || !tokens.length) return null;
    const first = parseCoordinate(tokens, 0);
    if (!first) return null;
    const second = parseCoordinate(tokens, first.index);
    if (!second || second.index !== tokens.length) return null;
    const firstValue = coordinateValue(first);
    const secondValue = coordinateValue(second);
    if (firstValue === null || secondValue === null) return null;

    const firstAxis = axisOf(first.hemisphere);
    const secondAxis = axisOf(second.hemisphere);
    let lat, lon;
    if (firstAxis && secondAxis) {
      if (firstAxis === secondAxis) return null;
      if (firstAxis === "lat") { lat = firstValue; lon = secondValue; }
      else { lat = secondValue; lon = firstValue; }
    } else if (firstAxis === "lat") { lat = firstValue; lon = secondValue; }
    else if (firstAxis === "lon") { lat = secondValue; lon = firstValue; }
    else if (secondAxis === "lat") { lat = secondValue; lon = firstValue; }
    else if (secondAxis === "lon") { lat = firstValue; lon = secondValue; }
    else { lat = firstValue; lon = secondValue; }

    if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
    return { lat, lon };
  }

  globalThis.parseCoordinates = parseCoordinates;
  if (typeof module === "object" && module && module.exports) module.exports = { parseCoordinates };
})();
