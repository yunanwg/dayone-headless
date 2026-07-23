/**
 * REST decrypted-content → export-shape mapper tests. Synthetic content only.
 */

import { expect, test } from "bun:test";
import { mapEntry, toIso } from "../src/ingest/rest/map.ts";

test("toIso: epoch ms and ISO strings → ISO-8601 UTC without milliseconds", () => {
  expect(toIso(1_626_942_600_000)).toBe("2021-07-22T08:30:00Z");
  expect(toIso("2020-01-01T00:00:00.000Z")).toBe("2020-01-01T00:00:00Z");
  expect(toIso(undefined)).toBeUndefined();
  expect(toIso(null)).toBeUndefined();
});

test("mapEntry normalizes an entry to the export shape", () => {
  const content = {
    id: "AAAA1111BBBB2222CCCC3333DDDD4444",
    date: 1_626_942_600_000, // 2021-07-22T08:30:00Z
    userEditDate: 1_626_946_200_000,
    timeZone: "Europe/Paris",
    body: "# Hi\n\nsynthetic body",
    richTextJSON: '{"meta":{"version":1},"contents":[]}',
    starred: true,
    isPinned: false,
    isAllDay: false,
    editingTime: 12,
    tags: ["travel"],
    clientMeta: {
      creationDevice: "Example's iPhone",
      creationDeviceModel: "iPhone14,2",
      creationDeviceType: "iPhone",
      creationOSName: "iOS",
      creationOSVersion: "17.4",
    },
    location: { latitude: 1.5, longitude: 2.5, placeName: "P", localityName: "L", country: "C" },
    weather: {
      code: "clear",
      description: "Clear",
      tempCelsius: 20,
      pressureMb: 1013,
      service: "WeatherKit",
      visibilityKm: 10,
      windSpeedKph: 5,
      moonPhase: 0.5,
      sunriseDate: 1_626_900_000_000,
    },
    moments: [
      // M1 carries a well-formed md5; M2's is malformed and must be dropped.
      { id: "M1", md5: "a1b2c3d4e5f6a7b8a1b2c3d4e5f6a7b8", contentType: "image/jpeg", momentType: "photo" },
      { id: "M2", md5: "not-a-real-md5", contentType: "video/mp4", momentType: "video" },
    ],
  };

  const e = mapEntry(content, { editDate: 1_626_946_200_000 }) as any;

  expect(e.uuid).toBe("AAAA1111BBBB2222CCCC3333DDDD4444");
  expect(e.creationDate).toBe("2021-07-22T08:30:00Z"); // ms stripped
  expect(e.modifiedDate).toBe("2021-07-22T09:30:00Z");
  expect(e.text).toBe("# Hi\n\nsynthetic body");
  expect(e.richText).toBe('{"meta":{"version":1},"contents":[]}');
  expect(e.starred).toBe(true);
  expect(e.isPinned).toBe(false);
  expect(e.tags).toEqual(["travel"]);

  // clientMeta flattened onto the entry
  expect(e.creationDevice).toBe("Example's iPhone");
  expect(e.creationOSName).toBe("iOS");

  // weather keys renamed to the export convention
  expect(e.weather.weatherCode).toBe("clear");
  expect(e.weather.conditionsDescription).toBe("Clear");
  expect(e.weather.temperatureCelsius).toBe(20);
  expect(e.weather.pressureMB).toBe(1013);
  expect(e.weather.weatherServiceName).toBe("WeatherKit");
  expect(e.weather.windSpeedKPH).toBe(5);
  expect(e.weather.sunriseDate).toBe("2021-07-21T20:40:00Z");

  // moments grouped into media buckets, metadata only
  expect(e.photos).toHaveLength(1);
  expect(e.videos).toHaveLength(1);
  expect(e.audios).toBeUndefined();
  expect(e.photos[0].identifier).toBe("M1");
  expect(e.photos[0].md5).toBe("a1b2c3d4e5f6a7b8a1b2c3d4e5f6a7b8");
  expect(e.photos[0].type).toBe("jpeg");
  expect(e.videos[0].type).toBe("mp4");
  // Hygiene: a malformed md5 is dropped at mapping time, never entering the mirror.
  expect(e.videos[0].md5).toBeUndefined();
});
