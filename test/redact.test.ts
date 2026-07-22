/**
 * Redactor tests. Uses ONLY a small synthetic export constructed inline — never
 * real journal content — per the project's privacy rule.
 */

import { test, expect } from "bun:test";
import { redactExport } from "../scripts/redact-export.ts";
import type { DayOneExport } from "../src/types.ts";

const MEDIA_ID = "PHOTOIDENTIFIER0000000000000001A";

function makeSynthetic(): DayOneExport {
  const richText = JSON.stringify({
    meta: { version: 1, "small-lines-removed": true },
    contents: [
      { text: "A private sentence about someone." },
      { embeddedObjects: [{ type: "image", identifier: MEDIA_ID }] },
    ],
  });

  return {
    metadata: { version: "1.0" },
    entries: [
      {
        uuid: "AAAA1111BBBB2222CCCC3333DDDD4444",
        creationDate: "2021-07-22T08:30:00Z",
        modifiedDate: "2021-07-22T09:00:00Z",
        timeZone: "Europe/Paris",
        text: "# Morning in Paris\n\nCoffee by the Seine.\n\n![](dayone-moment://" +
          MEDIA_ID +
          ")\n\n- item one\n- item two",
        richText,
        starred: true,
        isPinned: false,
        isAllDay: false,
        editingTime: 42,
        tags: ["travel", "paris"],
        sourceString: "com.dayoneapp.dayone",
        creationDevice: "Alex's iPhone",
        creationDeviceModel: "iPhone14,2",
        creationDeviceType: "iPhone",
        creationOSName: "iOS",
        creationOSVersion: "17.4",
        location: {
          region: {
            center: { longitude: 2.3522, latitude: 48.8566 },
            radius: 75,
            identifier: "REGIONIDENT01",
          },
          longitude: 2.3522,
          latitude: 48.8566,
          altitude: 35.5,
          placeName: "Rive Gauche",
          country: "France",
          administrativeArea: "Île-de-France",
          localityName: "Paris",
          timeZoneName: "Europe/Paris",
          userLabel: "Home away from home",
        },
        weather: {
          weatherCode: "clear",
          weatherServiceName: "HackWeather",
          conditionsDescription: "Clear",
          temperatureCelsius: 22.5,
          pressureMB: 1013,
          windBearing: 180,
          windSpeedKPH: 12,
          relativeHumidity: 55,
          moonPhase: 0.5,
          moonPhaseCode: "full",
        },
        photos: [
          {
            identifier: MEDIA_ID,
            md5: "0123456789abcdef0123456789abcdef",
            type: "jpeg",
            orderInEntry: 0,
            width: 4032,
            height: 3024,
            fileSize: 2500000,
            favorite: true,
            cameraMake: "Apple",
            cameraModel: "iPhone 14 Pro",
            lensModel: "iPhone 14 Pro back camera",
            fnumber: "1.78",
            focalLength: "6.86",
            filename: "IMG_4821.HEIC",
            appleCloudIdentifier: "CLOUDID12345",
          },
        ],
        // Unmodeled Record<string, unknown> — must be default-redacted.
        userActivity: { activityName: "Reading a private book title" },
      },
    ],
  };
}

/** Recursively assert two values share structure: type, keys, array length. */
function assertSameStructure(orig: unknown, red: unknown, path = "$"): void {
  if (Array.isArray(orig)) {
    expect(Array.isArray(red), `${path} array-ness`).toBe(true);
    const r = red as unknown[];
    expect(r.length, `${path} length`).toBe(orig.length);
    orig.forEach((el, i) => assertSameStructure(el, r[i], `${path}[${i}]`));
    return;
  }
  if (orig !== null && typeof orig === "object") {
    expect(red !== null && typeof red === "object", `${path} object-ness`).toBe(true);
    const o = orig as Record<string, unknown>;
    const r = red as Record<string, unknown>;
    expect(Object.keys(r).sort(), `${path} keys`).toEqual(Object.keys(o).sort());
    for (const k of Object.keys(o)) assertSameStructure(o[k], r[k], `${path}.${k}`);
    return;
  }
  // Leaf: types must match exactly.
  expect(typeof red, `${path} typeof`).toBe(typeof orig);
}

test("structure, key set, array lengths and leaf types are preserved", () => {
  const input = makeSynthetic();
  const out = redactExport(input);
  assertSameStructure(input, out);
});

test("referential integrity: moment ref in text resolves to the media identifier", () => {
  const out = redactExport(makeSynthetic());
  const entry = out.entries[0]!;
  const match = entry.text.match(/dayone-moment:\/\/([A-Za-z0-9._-]+)/);
  expect(match).not.toBeNull();
  const refInText = match![1];
  const mediaIdent = entry.photos![0]!.identifier;
  expect(refInText).toBe(mediaIdent);
  // …and it was actually changed from the original.
  expect(mediaIdent).not.toBe(MEDIA_ID);
  expect(mediaIdent).toHaveLength(MEDIA_ID.length);
});

test("richText stays a valid { meta, contents } JSON string, content redacted", () => {
  const input = makeSynthetic();
  const out = redactExport(input);
  const rt = JSON.parse(out.entries[0]!.richText!) as {
    meta: unknown;
    contents: Array<Record<string, unknown>>;
  };
  expect(rt.meta).toBeDefined();
  expect(Array.isArray(rt.contents)).toBe(true);

  // Its text leaf is redacted…
  const textNode = rt.contents[0] as { text: string };
  expect(textNode.text).not.toBe("A private sentence about someone.");
  // …and its embedded identifier is mapped consistently with the photo.
  const embed = (rt.contents[1] as { embeddedObjects: Array<{ identifier: string }> })
    .embeddedObjects[0]!;
  expect(embed.identifier).toBe(out.entries[0]!.photos![0]!.identifier);
});

test("private / identifying leaves are changed", () => {
  const input = makeSynthetic();
  const out = redactExport(input);
  const oe = input.entries[0]!;
  const re = out.entries[0]!;

  // Free text redacted.
  expect(re.text).not.toBe(oe.text);
  expect(re.location!.placeName).not.toBe("Rive Gauche");
  expect(re.location!.country).not.toBe("France");
  expect(re.location!.localityName).not.toBe("Paris");
  expect(re.location!.userLabel).not.toBe("Home away from home");

  // Tags redacted but count preserved.
  expect(re.tags).toHaveLength(2);
  expect(re.tags).not.toEqual(["travel", "paris"]);

  // Coordinates changed, still numbers.
  expect(re.location!.latitude).not.toBe(48.8566);
  expect(re.location!.longitude).not.toBe(2.3522);
  expect(typeof re.location!.altitude).toBe("number");
  expect(re.location!.region!.center!.latitude).not.toBe(48.8566);

  // Identifiers -> hex of same length.
  expect(re.uuid).not.toBe(oe.uuid);
  expect(re.uuid).toHaveLength(oe.uuid.length);
  expect(re.uuid).toMatch(/^[0-9a-f]+$/);
  const rp = re.photos![0]!;
  expect(rp.md5).not.toBe(oe.photos![0]!.md5);
  expect(rp.md5).toMatch(/^[0-9a-f]+$/);
  expect(rp.md5).toHaveLength(32);
  expect(rp.filename).not.toBe("IMG_4821.HEIC");
  expect(rp.filename).toHaveLength("IMG_4821.HEIC".length);
  expect(rp.appleCloudIdentifier).not.toBe("CLOUDID12345");

  // Unmodeled/private Record leaf is default-denied (redacted).
  const activity = (re as unknown as { userActivity: { activityName: string } })
    .userActivity.activityName;
  expect(activity).not.toBe("Reading a private book title");
});

test("non-private enum / metric / device fields are kept verbatim", () => {
  const input = makeSynthetic();
  const out = redactExport(input);
  const oe = input.entries[0]!;
  const re = out.entries[0]!;

  expect(out.metadata.version).toBe("1.0");
  expect(re.timeZone).toBe("Europe/Paris");
  expect(re.creationDate).toBe(oe.creationDate);
  expect(re.starred).toBe(true);
  // creationDevice is a display name ("<Name>'s iPhone") → redacted, not kept.
  expect(re.creationDevice).not.toBe("Alex's iPhone");
  expect(re.creationDevice).not.toContain("Alex");
  // …but the hardware id fields (model/type) are non-identifying and kept.
  expect(re.creationDeviceModel).toBe("iPhone14,2");
  expect(re.creationDeviceType).toBe("iPhone");
  expect(re.creationOSName).toBe("iOS");
  expect(re.weather!.weatherCode).toBe("clear");
  expect(re.weather!.conditionsDescription).toBe("Clear");
  expect(re.weather!.temperatureCelsius).toBe(22.5);
  expect(re.weather!.moonPhase).toBe(0.5);

  const rp = re.photos![0]!;
  expect(rp.type).toBe("jpeg");
  expect(rp.width).toBe(4032);
  expect(rp.height).toBe(3024);
  expect(rp.fileSize).toBe(2500000);
  expect(rp.orderInEntry).toBe(0);
  expect(rp.cameraMake).toBe("Apple");
  expect(rp.cameraModel).toBe("iPhone 14 Pro");
  expect(rp.fnumber).toBe("1.78");
});

test("redaction is deterministic", () => {
  const a = JSON.stringify(redactExport(makeSynthetic()));
  const b = JSON.stringify(redactExport(makeSynthetic()));
  expect(a).toBe(b);
});

test("non-ASCII text (CJK / accented) is redacted, not passed through", () => {
  // Regression: real journals are multilingual; an ASCII-only [A-Za-z0-9] matcher
  // would leak every CJK/accented word verbatim.
  // All tokens below are SYNTHETIC dictionary words, never real journal content.
  const input = makeSynthetic();
  const e = input.entries[0]!;
  e.text = "示例：这是一段用于测试的中文内容 — café crème ☕";
  e.tags = ["示例", "café"];
  e.location!.placeName = "样例城区";
  const out = redactExport(input);
  const re = out.entries[0]!;
  for (const leaked of ["示例", "测试", "中文", "内容", "café", "crème"]) {
    expect(re.text).not.toContain(leaked);
  }
  expect(re.tags!.join(",")).not.toContain("示例");
  expect(re.tags!.join(",")).not.toContain("café");
  expect(re.location!.placeName).not.toContain("样例");
});
