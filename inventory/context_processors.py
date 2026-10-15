from .models import SystemSetting


def system_context(request):
    return {
        "system_setting": SystemSetting.current(),
    }
