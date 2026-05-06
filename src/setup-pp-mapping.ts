import "dotenv/config";
import { google } from "googleapis";
import { readFileSync } from "node:fs";

const MAPPING_SHEET = "PP 매핑";

// 식스샵 상품명 → SS originProductNo (29개 confirmed). null = SS 미판매
const MAPPING: Record<string, number | null> = {
  "Jacquard Fast Charging Cable (7color)": 11449641752,
  "180° Fast Charging Cable (8color)": 12626896003,
  "Metallic Hair Pin": 12659660500,
  "Freestanding Holder (Silver)": 10412786795,
  "Miniature Refrigerator Magnet": 12434433055,
  "Metallic Ribbon Passport Case": 12757255891,
  "Curve Toilet Mini Brush (4color)": 12659581106,
  "Soft Silicone Carry Pouch (9color)": 12659697137,
  "Cloud Grip Glass Mini Brush (3color)": 12659521325,
  "Stripe Sucker Drawstring Pouch (4color)": 12717146576,
  "Poni Mesh pouch bag (4color)": 11491934097,
  "TRAVELER pouch bag (5color)": 11524947528,
  "Corduroy Drawstring Pouch (5color)": 12659557092,
  "Wirst Rest Mouse Pad (8color)": 13316384937,
  "Kitsch Pop Hair Pin": 12659617268,
  "Check Mirror Smart Tok (4color)": 12717131712,
  "Toy Screw Hook (Set)": 12659711603,
  "Pixel Mini Handle Pouch (4color)": 12434723552,
  "Compact Phone Stand (6color)": 12659544857,
  "Ball hanger (6color)": null,
  "STAINLESS STEEL TRAY (silver)": 11779969107,
  "1+1 Silk Scrunch (9color)": 11525494276,
  "Basic Toliet Slippers (6color)": 13316409005,
  "Character Snack Clip (4color)": 12659492397,
  "360° Rotating Phone Holder": null,
  "Food Bottle Opener": 12560362204,
  "Fuzzy Stripe Slippers (3color)": 12659591974,
  "Padded Color Pouch (4color)": 12659675938,
  "Cotton Lunch Mini Bag (5color)": 12659568722,
  "Arrow Magnet (Set)": 12659476551,
  "Light UV 99.9 Umbrella (7color)": 12359059623,
};

function getSheetsClient() {
  const creds = JSON.parse(readFileSync(process.env.GOOGLE_SERVICE_ACCOUNT_PATH!, "utf8"));
  const auth = new google.auth.GoogleAuth({
    credentials: creds,
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });
  return google.sheets({ version: "v4", auth });
}

async function main(): Promise<void> {
  const sheets = getSheetsClient();
  const spreadsheetId = process.env.SHEET_ID!;

  // 1) 시트 존재 확인 / 생성
  const meta = await sheets.spreadsheets.get({ spreadsheetId });
  let sheetId = meta.data.sheets?.find((s) => s.properties?.title === MAPPING_SHEET)?.properties?.sheetId;
  if (sheetId == null) {
    const r = await sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: { requests: [{ addSheet: { properties: { title: MAPPING_SHEET } } }] },
    });
    sheetId = r.data.replies?.[0]?.addSheet?.properties?.sheetId ?? undefined;
    console.log(`created sheet "${MAPPING_SHEET}" sheetId=${sheetId}`);
  }

  // 2) clear & 헤더+데이터+수식 작성
  await sheets.spreadsheets.values.clear({ spreadsheetId, range: `${MAPPING_SHEET}!A:Z` });

  const header = [
    "식스샵 상품명",
    "SS상품번호",
    "비고",
    "식스샵 총재고",
    "식스샵 총판매",
    "SS 판매",
    "남은재고",
    "리오더 알림",
  ];
  const values: (string | number)[][] = [header];
  let r = 2;
  for (const [sixName, ssId] of Object.entries(MAPPING)) {
    const ssCell = ssId == null ? "" : ssId;
    const note = ssId == null ? "SS 미판매" : "";
    // D: 식스샵 총재고 — PP 재고마스터에서 상품명(B열)이 일치하는 행의 현재재고(E열) 합
    // E: 식스샵 총판매 — PP 재고마스터 F열(식스샵 판매수량) 합
    //   주의: 현재 PP 재고마스터는 SS 컬럼 추가로 9-col, 식스샵 판매는 F열에 위치
    // F: SS 판매 — PP SS주문로그 K열(SS상품번호)이 B와 일치하는 행의 H열(수량) 합
    // G: 남은재고 = D - E - F
    // H: 리오더 알림 (남은재고 임계치)
    values.push([
      sixName,
      ssCell,
      note,
      `=IFERROR(SUMIF('PP 재고마스터'!B:B, A${r}, 'PP 재고마스터'!E:E), 0)`,
      `=IFERROR(SUMIF('PP 재고마스터'!B:B, A${r}, 'PP 재고마스터'!F:F), 0)`,
      `=IF(B${r}="", 0, IFERROR(SUMIF('PP SS주문로그'!K:K, B${r}, 'PP SS주문로그'!H:H), 0))`,
      `=D${r}-E${r}-F${r}`,
      `=IF(G${r}<=20, "⚠ 리오더", IF(G${r}<=50, "⚡ 임박", ""))`,
    ]);
    r++;
  }

  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: `${MAPPING_SHEET}!A1`,
    valueInputOption: "USER_ENTERED",
    requestBody: { values },
  });
  console.log(`wrote ${values.length - 1} mapping rows to ${MAPPING_SHEET}`);

  // 3) 헤더 행 + 첫 컬럼 필터 추가 (정렬 가능)
  if (sheetId != null) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: {
        requests: [
          { clearBasicFilter: { sheetId } },
          {
            setBasicFilter: {
              filter: {
                range: {
                  sheetId,
                  startRowIndex: 0,
                  endRowIndex: values.length,
                  startColumnIndex: 0,
                  endColumnIndex: header.length,
                },
              },
            },
          },
        ],
      },
    });
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
