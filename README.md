# CARD CLASH Online

Phiên bản website online của CARD CLASH với tìm đối thủ ngẫu nhiên.

Người chơi chỉ cần vào website, nhập tên nhân vật, chọn độ khó và bấm `TÌM TRẬN`.

## Chạy local

```bash
npm install
npm start
```

Mở:

```txt
http://localhost:3000
```

Để test ghép trận trên cùng máy, mở 2 tab trình duyệt cùng vào `http://localhost:3000`, nhập 2 tên nhân vật khác nhau, chọn cùng độ khó rồi bấm `TÌM TRẬN`.

## Đưa lên website bằng Render

1. Tạo tài khoản tại `https://render.com`.
2. Đưa thư mục `card-clash-online` lên một GitHub repo.
3. Trong Render, chọn `New` -> `Web Service`.
4. Kết nối repo GitHub đó.
5. Render sẽ tự đọc `render.yaml`.
6. Bấm deploy.

Sau khi deploy xong, Render sẽ cấp một link dạng:

```txt
https://card-clash-online.onrender.com
```

Người chơi chỉ cần mở link đó để chơi online.

## Test sau khi deploy

Mở website bằng 2 tab hoặc 2 thiết bị khác nhau:

1. Người chơi A nhập tên, chọn độ khó, bấm `TÌM TRẬN`.
2. Người chơi B nhập tên, chọn cùng độ khó, bấm `TÌM TRẬN`.
3. Server sẽ tự ghép 2 người vào cùng một phòng.

## Nền tảng khác

Có thể deploy nguyên thư mục này lên các nền tảng chạy Node.js như Railway, Fly.io hoặc VPS riêng.

Các lệnh cần cấu hình:

```txt
Build command: npm install
Start command: npm start
Port: dùng biến môi trường PORT do nền tảng cấp
```

Server sẽ:

- Tạo hàng chờ tìm đối thủ theo độ khó.
- Ghép 2 người chơi vào một phòng.
- Giữ trạng thái bài, lượt, điểm và kỹ năng ở phía server.
- Cho mỗi người chơi dùng mỗi kỹ năng đúng 1 lần trong cả ván.
