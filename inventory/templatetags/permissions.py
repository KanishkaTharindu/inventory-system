from django import template

register = template.Library()


@register.filter
def has_feature(user, feature):
    return user.is_authenticated and user.has_feature(feature)


@register.filter
def item_at(mapping, key):
    return mapping.get(key, 0)
