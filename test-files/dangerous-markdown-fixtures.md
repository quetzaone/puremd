# Negative Markdown fixtures

<script>alert('xss')</script>
<img src="https://attacker.example/track.png" onerror="alert('xss')">
<svg><a href="javascript:alert('xss')">x</a></svg>
<iframe src="https://attacker.example/"></iframe>

[JavaScript](javascript:alert('xss'))
[Data URI](data:text/html,&lt;script&gt;alert('xss')&lt;/script&gt;)
[File URI](file:///C:/Windows/win.ini)
[HTTPS remains user-confirmed](https://example.com/)

![Remote image must stay a placeholder](https://attacker.example/image.png)
